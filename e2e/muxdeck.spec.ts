import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, rmSync } from "node:fs";
import { test, expect, type Page } from "@playwright/test";

const sessionName = `muxdeck-browser-${process.pid}`;
const alternateSessionName = `${sessionName}-alternate`;
const socketName = process.env.MUXDECK_PLAYWRIGHT_TMUX_SOCKET || "muxdeck-playwright-test";
const tmux = ["-L", socketName];
const titlesFile = process.env.MUXDECK_PLAYWRIGHT_TITLES_FILE;
const messagesFile = process.env.MUXDECK_PLAYWRIGHT_MESSAGES_FILE;
const snippetsFile = process.env.MUXDECK_PLAYWRIGHT_SNIPPETS_FILE;
const workspacesFile = process.env.MUXDECK_PLAYWRIGHT_WORKSPACES_FILE;
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

function workspaceTmuxIdentity(name: string): string {
  return execFileSync(
    "tmux",
    [
      ...tmux,
      "list-panes",
      "-t",
      `=${name}`,
      "-F",
      "#{session_name}=#{session_id}:#{pane_id}:#{pane_pid}:#{pane_dead}",
    ],
    { encoding: "utf8" },
  ).trim();
}

function workspaceTmuxSnapshot(name: string): string {
  const panes = execFileSync(
    "tmux",
    [
      ...tmux,
      "list-panes",
      "-t",
      `=${name}`,
      "-F",
      "#{pane_id}:#{window_width}x#{window_height}:#{pane_width}x#{pane_height}",
    ],
    { encoding: "utf8" },
  ).trim();
  const content = panes.split("\n").map((pane) => {
    const paneId = pane.split(":", 1)[0];
    return execFileSync(
      "tmux",
      [...tmux, "capture-pane", "-p", "-t", paneId],
      { encoding: "utf8" },
    );
  }).join("\n--- pane ---\n");
  return `${workspaceTmuxIdentity(name)}\n${panes}\n${content}`;
}

function workspaceTmuxContentSnapshot(name: string): string {
  const paneIds = execFileSync(
    "tmux",
    [...tmux, "list-panes", "-t", `=${name}`, "-F", "#{pane_id}"],
    { encoding: "utf8" },
  ).trim().split("\n");
  const content = paneIds.map((currentPaneId) => execFileSync(
    "tmux",
    [...tmux, "capture-pane", "-J", "-p", "-S", "-", "-t", currentPaneId],
    { encoding: "utf8" },
  ).trimEnd()).join("\n--- pane ---\n");
  return `${workspaceTmuxIdentity(name)}\n${content}`;
}

function workspacePaneHeight(name: string): number {
  const height = execFileSync(
    "tmux",
    [...tmux, "list-panes", "-t", `=${name}`, "-F", "#{pane_height}"],
    { encoding: "utf8" },
  ).trim().split("\n", 1)[0];
  return Number(height);
}

if (!titlesFile || !messagesFile || !snippetsFile || !workspacesFile) {
  throw new Error("Playwright state paths were not configured");
}

test.beforeAll(() => {
  rmSync(titlesFile, { force: true });
  rmSync(messagesFile, { force: true });
  rmSync(snippetsFile, { force: true });
  rmSync(workspacesFile, { force: true });
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
  rmSync(workspacesFile, { force: true });
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

test("dashboard recognizes the official npm Copilot launcher process shape", async ({ page }) => {
  const copilotSession = `${sessionName}-copilot-wrapper`;
  execFileSync("tmux", [
    ...tmux,
    "new-session",
    "-d",
    "-s",
    copilotSession,
    "node",
    "-e",
    'require("node:child_process").spawnSync("/bin/sleep", ["120"], {stdio: "inherit"})',
  ]);
  const copilotPane = execFileSync(
    "tmux",
    [...tmux, "list-panes", "-t", `=${copilotSession}`, "-F", "#{pane_id}"],
    { encoding: "utf8" },
  ).trim();
  execFileSync("tmux", [
    ...tmux,
    "select-pane",
    "-t",
    copilotPane,
    "-T",
    "Review status detection - GitHub Copilot",
  ]);

  try {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/mux/?kind=copilot");

    const openCopilot = page.getByRole("button", { name: `Open ${copilotSession}` });
    await expect(openCopilot).toBeVisible();
    const card = openCopilot.locator("xpath=ancestor::article[contains(@class, 'session-card')]");
    await expect(card.locator(".agent-badge")).toHaveText("Copilot");
    await expect(card.locator(".state-badge")).toContainText("Unclear");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
      .toBe(true);

    await page.getByRole("button", { name: "agents", exact: true }).click();
    await expect(openCopilot).toBeVisible();
  } finally {
    try {
      execFileSync("tmux", [...tmux, "kill-session", "-t", `=${copilotSession}`], {
        stdio: "ignore",
      });
    } catch {
      // Cleanup stays scoped to the test's disposable tmux server.
    }
  }
});

test("mobile End terminates only the confirmed tmux session and selects its neighbor", async ({ page }) => {
  const targetSession = `${sessionName}-terminate-target`;
  const survivorSession = `${sessionName}-terminate-survivor`;
  for (const name of [targetSession, survivorSession]) {
    execFileSync("tmux", [
      ...tmux,
      "new-session",
      "-d",
      "-s",
      name,
      "bash",
      "--noprofile",
      "--norc",
    ]);
  }
  const survivorIdentity = workspaceTmuxIdentity(survivorSession);

  try {
    await page.setViewportSize({ width: 320, height: 568 });
    await page.goto(
      `/mux/session/${encodeURIComponent(targetSession)}`
      + `?tab=${encodeURIComponent(survivorSession)}`
      + `&tab=${encodeURIComponent(targetSession)}`,
    );
    await expect(page.locator(".connection-badge")).toContainText("Live", { timeout: 10_000 });

    const terminalControls = page.getByRole("navigation", { name: "Terminal view controls" });
    const endSession = terminalControls.getByRole("button", {
      name: "Terminate tmux session",
    });
    await expect(endSession).toBeVisible();
    await expect(endSession).toBeInViewport();
    const endBox = await endSession.boundingBox();
    expect(endBox?.width).toBeGreaterThanOrEqual(44);
    expect(endBox?.height).toBeGreaterThanOrEqual(44);
    await endSession.click();

    const confirmation = page.getByRole("alertdialog", {
      name: "Terminate tmux session?",
    });
    await expect(confirmation).toBeVisible();
    await expect(confirmation).toContainText(targetSession);
    await expect(confirmation).toContainText("every pane");
    await expect(confirmation.getByRole("button", { name: "Cancel" })).toBeFocused();
    await expect(confirmation.getByRole("button", {
      name: "Terminate session",
    })).toBeInViewport();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
      .toBe(true);

    await confirmation.getByRole("button", { name: "Terminate session" }).click();

    await expectRoute(
      page,
      `/mux/session/${survivorSession}`,
      [survivorSession],
    );
    await expect(page.locator(".connection-badge")).toContainText("Live", { timeout: 10_000 });
    await expect.poll(() => {
      try {
        execFileSync("tmux", [...tmux, "has-session", "-t", `=${targetSession}`], {
          stdio: "ignore",
        });
        return true;
      } catch {
        return false;
      }
    }).toBe(false);
    expect(workspaceTmuxIdentity(survivorSession)).toBe(survivorIdentity);
  } finally {
    for (const name of [targetSession, survivorSession]) {
      try {
        execFileSync("tmux", [...tmux, "kill-session", "-t", `=${name}`], {
          stdio: "ignore",
        });
      } catch {
        // Cleanup stays scoped to sessions created on the disposable socket.
      }
    }
  }
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

test("Grok theme matching stages a reviewed command before writing to tmux", async ({ page }) => {
  const grokSession = `${sessionName}-grok-theme`;
  const fakeGrokDir = `/tmp/${grokSession}-bin`;
  const fakeGrok = `${fakeGrokDir}/grok`;
  mkdirSync(fakeGrokDir, { recursive: true });
  copyFileSync("/bin/cat", fakeGrok);
  chmodSync(fakeGrok, 0o700);
  execFileSync("tmux", [
    ...tmux,
    "new-session",
    "-d",
    "-s",
    grokSession,
    fakeGrok,
  ]);

  try {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/mux/session/${encodeURIComponent(grokSession)}`);
    await expect(page.locator(".connection-badge")).toContainText("Live", {
      timeout: 10_000,
    });
    const terminalBefore = workspaceTmuxContentSnapshot(grokSession);

    await page.getByRole("button", { name: "Light theme" }).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    expect(workspaceTmuxContentSnapshot(grokSession)).toBe(terminalBefore);

    await page.getByRole("button", {
      name: "Stage grokday theme command for Grok",
    }).click();
    await expect(page.getByRole("textbox", { name: "Staged input" }))
      .toHaveValue("/theme grokday");
    await expect(page.getByRole("main")).toHaveAttribute("data-mobile-focus", "input");
    expect(workspaceTmuxContentSnapshot(grokSession)).toBe(terminalBefore);

    await page.getByRole("button", { name: "Send + Enter" }).click();
    await expect.poll(() => workspaceTmuxContentSnapshot(grokSession))
      .toContain("/theme grokday");
  } finally {
    try {
      execFileSync("tmux", [...tmux, "kill-session", "-t", `=${grokSession}`], {
        stdio: "ignore",
      });
    } catch {
      // Cleanup stays scoped to the disposable Playwright tmux server.
    }
    rmSync(fakeGrokDir, { force: true, recursive: true });
  }
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

test("session tags persist, search, group, include, and reverse-filter through the URL", async ({
  page,
  request,
}) => {
  const reviewSession = `${sessionName}-tag-review`;
  execFileSync("tmux", [
    ...tmux,
    "new-session",
    "-d",
    "-s",
    reviewSession,
    "bash",
    "--noprofile",
    "--norc",
  ]);
  const primaryBefore = workspaceTmuxContentSnapshot(sessionName);
  const reviewBefore = workspaceTmuxContentSnapshot(reviewSession);

  try {
    const reviewTags = await request.put("/mux/api/session-tags", {
      data: { session: reviewSession, tags: ["review"] },
    });
    expect(reviewTags.ok()).toBe(true);

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/mux/");
    await expect(page.getByRole("button", {
      name: `Open ${sessionName}`,
      exact: true,
    })).toBeVisible();
    await page.getByRole("button", {
      name: `Edit title and tags for ${sessionName}`,
      exact: true,
    }).click();
    const detailsDialog = page.getByRole("dialog", { name: "Edit title and tags" });
    await detailsDialog.getByText("Work", { exact: true }).click();
    await detailsDialog.getByText("Urgent", { exact: true }).click();
    await page.getByRole("button", { name: "Save details" }).click();
    await expect(page.getByRole("dialog", { name: "Edit title and tags" })).toBeHidden();
    const primaryCard = page.getByRole("button", {
      name: `Open ${sessionName}`,
      exact: true,
    });
    await expect(primaryCard.locator(".session-tag-list")).toContainText("Work");
    await expect(primaryCard.locator(".session-tag-list")).toContainText("Urgent");

    await page.reload();
    await expect(primaryCard.locator(".session-tag-list")).toContainText("Work");
    await page.getByRole("button", { name: /^Add Work include filter,/ }).click();
    await expect(page).toHaveURL("/mux/?tag=work");
    await expect(primaryCard).toBeVisible();
    await expect(page.getByRole("button", {
      name: `Open ${reviewSession}`,
      exact: true,
    })).toBeHidden();

    const excludeMode = page.getByRole("button", { name: "Exclude matches" });
    const excludeBox = await excludeMode.boundingBox();
    expect(excludeBox?.height).toBeGreaterThanOrEqual(44 - CSS_PIXEL_TOLERANCE);
    await excludeMode.click();
    await expect(page).toHaveURL("/mux/?not-tag=work");
    await expect(primaryCard).toBeHidden();
    const reviewCard = page.getByRole("button", {
      name: `Open ${reviewSession}`,
      exact: true,
    });
    await expect(reviewCard).toBeVisible();

    await reviewCard.click();
    await expectRoute(page, `/mux/session/${reviewSession}`, [reviewSession], {
      "not-tag": "work",
    });
    await page.goBack();
    await expectRoute(page, "/mux/", [reviewSession], { "not-tag": "work" });
    await expect(reviewCard).toBeVisible();
    await page.goForward();
    await expectRoute(page, `/mux/session/${reviewSession}`, [reviewSession], {
      "not-tag": "work",
    });
    await page.goBack();
    await expectRoute(page, "/mux/", [reviewSession], { "not-tag": "work" });

    await page.getByRole("button", { name: "Clear tag filters" }).click();
    await page.getByLabel("Find a session").fill("urgent");
    await expect(page).toHaveURL("/mux/?q=urgent&tab=" + encodeURIComponent(reviewSession));
    await expect(primaryCard).toBeVisible();
    await expect(reviewCard).toBeHidden();
    await page.getByRole("button", { name: "Clear search" }).click();
    await page.getByRole("button", { name: "Group Tags / labels" }).click();
    await expect(page.getByRole("heading", { name: "Work", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Review", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Urgent", exact: true })).toBeVisible();
    await expect(page.getByRole("button", {
      name: `Open ${sessionName}`,
      exact: true,
    })).toHaveCount(2);

    await page.setViewportSize({ width: 320, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
      .toBe(true);
    expect(workspaceTmuxContentSnapshot(sessionName)).toBe(primaryBefore);
    expect(workspaceTmuxContentSnapshot(reviewSession)).toBe(reviewBefore);
  } finally {
    for (const name of [sessionName, reviewSession]) {
      await request.put("/mux/api/session-tags", {
        data: { session: name, tags: [] },
      }).catch(() => undefined);
    }
    try {
      execFileSync("tmux", [...tmux, "kill-session", "-t", `=${reviewSession}`], {
        stdio: "ignore",
      });
    } catch {
      // Cleanup stays scoped to the test's disposable tmux server.
    }
  }
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
  await expect(page.getByRole("button", {
    name: `Open ${sessionName}`,
    exact: true,
  })).toBeVisible();
  await expect(page.getByLabel("Find a session")).toHaveValue(sessionName);
  await expect(page.getByRole("button", { name: "shells", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("button", { name: /Other/ })).toHaveAttribute("aria-pressed", "true");

  const newWindowLink = page.getByRole("link", {
    name: `Open ${sessionName} in new window`,
    exact: true,
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

  await page.getByRole("button", { name: `Open ${sessionName}`, exact: true }).click();
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
  const requestedSessionName = `${sessionName}-named-#{pid}`;

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
    const nameInput = page.getByRole("textbox", { name: /tmux session name/i });
    await expect(nameInput).toHaveAttribute("maxlength", "256");
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

    await nameInput.fill(requestedSessionName);
    await page.getByRole("button", { name: "Create session" }).click();
    const createdInSpa = await createdSessionName(page);
    expect(createdInSpa).toBe(requestedSessionName);
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

test("tab bar opens and cancels New session without a dashboard round trip", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(
    `/mux/session/${encodeURIComponent(sessionName)}?kind=shells&tab=${encodeURIComponent(sessionName)}`,
  );
  await expect(page.locator(".connection-badge")).toContainText("Live", { timeout: 10_000 });
  await expectRoute(page, `/mux/session/${sessionName}`, [sessionName], { kind: "shells" });

  const historyLength = await page.evaluate(() => window.history.length);
  const newSessionButton = page.getByRole("button", { name: "New session", exact: true });
  await expect(newSessionButton).toBeVisible();
  await expect(newSessionButton).toBeEnabled();
  await newSessionButton.click();

  await expectRoute(page, "/mux/sessions/new", [sessionName], { kind: "shells" });
  await expect(newSessionButton).toBeDisabled();
  expect(await page.evaluate(() => window.history.length)).toBe(historyLength);

  await page.getByRole("button", { name: "Cancel" }).click();
  await expectRoute(page, `/mux/session/${sessionName}`, [sessionName], { kind: "shells" });
  expect(await page.evaluate(() => window.history.length)).toBe(historyLength);
  await expect(page.getByRole("tab", { name: new RegExp(sessionName) })).toBeFocused();

  await newSessionButton.click();
  await page.getByRole("button", { name: "Close New session tab" }).click();
  await expectRoute(page, `/mux/session/${sessionName}`, [sessionName], { kind: "shells" });
  await expect(page.getByRole("tab", { name: new RegExp(sessionName) })).toBeFocused();
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
  await resizeHandle.hover({
    position: { x: handleBox.width / 2, y: handleBox.height / 2 },
  });
  const activeHandleBox = await resizeHandle.boundingBox();
  if (!activeHandleBox) throw new Error("Scrollback resize handle moved out of view");
  const startX = activeHandleBox.x + activeHandleBox.width / 2;
  const startY = activeHandleBox.y + activeHandleBox.height / 2;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await expect(page.locator("html")).toHaveClass(/history-resizing/);
  await page.mouse.move(startX - 140, startY, { steps: 4 });
  await page.mouse.up();
  await expect(page.locator("html")).not.toHaveClass(/history-resizing/);
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

test("desktop Copy mode uses the browser clipboard while a TUI owns the mouse", async ({
  context,
  page,
}) => {
  test.setTimeout(45_000);
  await context.grantPermissions(["clipboard-read", "clipboard-write"], {
    origin: "http://127.0.0.1:7684",
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/mux/session/${sessionName}?tab=${encodeURIComponent(sessionName)}`);
  await expect(page.locator(".connection-badge")).toContainText("Live", {
    timeout: 10_000,
  });

  await page.evaluate(() => {
    const terminalFrames: number[][] = [];
    const nativeSend = WebSocket.prototype.send;
    WebSocket.prototype.send = function send(data) {
      if (this.url.includes("/ws/terminal")) {
        if (data instanceof ArrayBuffer) {
          terminalFrames.push([...new Uint8Array(data)]);
        } else if (ArrayBuffer.isView(data)) {
          terminalFrames.push([
            ...new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
          ]);
        }
      }
      return nativeSend.call(this, data);
    };
    Object.defineProperty(window, "__muxdeckCopyModeTerminalFrames", {
      value: terminalFrames,
    });
  });
  const terminalFrameCount = () => page.evaluate(() => (
    window as Window & { __muxdeckCopyModeTerminalFrames: number[][] }
  ).__muxdeckCopyModeTerminalFrames.length);
  const copyText = "MUXDECK_BROWSER_COPY_TARGET";
  const pasteText = "MUXDECK_BROWSER_PASTE_TARGET";

  try {
    execFileSync("tmux", [
      ...tmux,
      "send-keys",
      "-t",
      paneId,
      "-l",
      `printf '\\033[2J\\033[H\\033[?1003h%s\\n' '${copyText}'`,
    ]);
    execFileSync("tmux", [...tmux, "send-keys", "-t", paneId, "Enter"]);
    await expect.poll(() => workspaceTmuxContentSnapshot(sessionName))
      .toContain(copyText);

    const shell = page.locator(".console-shell");
    const copyMode = page.getByRole("button", { name: "Browser terminal copy mode" });
    const terminalScreen = page.locator(".terminal-host .xterm-screen");
    await expect(copyMode).toBeVisible();
    await expect(copyMode).toHaveAttribute("aria-pressed", "false");
    await copyMode.click();
    await expect(copyMode).toHaveAttribute("aria-pressed", "true");
    await expect(shell).toHaveAttribute("data-desktop-copy-mode", "true");
    await expect(page.locator(".terminal-stage")).toHaveAttribute("data-copy-mode", "true");

    const screenBox = await terminalScreen.boundingBox();
    expect(screenBox).not.toBeNull();
    const cellHeight = screenBox!.height / workspacePaneHeight(sessionName);
    const frameCountBeforeSelection = await terminalFrameCount();
    await page.mouse.move(screenBox!.x + 2, screenBox!.y + (cellHeight / 2));
    await page.mouse.down();
    await page.mouse.move(
      screenBox!.x + screenBox!.width - 4,
      screenBox!.y + (cellHeight / 2),
      { steps: 8 },
    );
    await page.mouse.up();
    await page.keyboard.press("Control+C");

    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText()))
      .toContain(copyText);
    expect(await terminalFrameCount()).toBe(frameCountBeforeSelection);

    await page.evaluate((text) => navigator.clipboard.writeText(text), pasteText);
    await page.keyboard.press("Control+V");
    await expect.poll(() => workspaceTmuxContentSnapshot(sessionName))
      .toContain(pasteText);

    await page.setViewportSize({ width: 390, height: 844 });
    await expect(copyMode).toBeHidden();
    await expect(shell).toHaveAttribute("data-desktop-copy-mode", "false");
    await expect(page.locator(".terminal-stage")).toHaveAttribute("data-copy-mode", "false");
  } finally {
    execFileSync("tmux", [...tmux, "send-keys", "-t", paneId, "C-c"]);
    execFileSync("tmux", [
      ...tmux,
      "send-keys",
      "-t",
      paneId,
      "-l",
      "printf '\\033[?1003l'",
    ]);
    execFileSync("tmux", [...tmux, "send-keys", "-t", paneId, "Enter"]);
  }
});

test("desktop terminal focus fills the viewport without replacing the live session", async ({
  page,
}) => {
  test.setTimeout(45_000);
  let terminalSocketCount = 0;
  page.on("websocket", (socket) => {
    if (socket.url().includes("/ws/terminal")) terminalSocketCount += 1;
  });

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/mux/session/${sessionName}?tab=${encodeURIComponent(sessionName)}`);
  await expect(page.locator(".connection-badge")).toContainText("Live", {
    timeout: 10_000,
  });
  await expect.poll(() => terminalSocketCount).toBe(1);

  await page.evaluate(() => {
    const terminalFramesSentDuringKeydown: string[] = [];
    let handlingKeydown = false;
    const nativeSend = WebSocket.prototype.send;
    window.addEventListener("keydown", () => {
      handlingKeydown = true;
      window.queueMicrotask(() => {
        handlingKeydown = false;
      });
    }, { capture: true });
    WebSocket.prototype.send = function send(data) {
      let isResize = false;
      if (typeof data === "string") {
        try {
          isResize = JSON.parse(data).type === "resize";
        } catch {
          // A non-JSON string is terminal input.
        }
      }
      if (handlingKeydown && this.url.includes("/ws/terminal") && !isResize) {
        terminalFramesSentDuringKeydown.push(this.url);
      }
      return nativeSend.call(this, data);
    };
    Object.defineProperty(window, "__muxdeckDesktopFocusTerminalFrames", {
      value: terminalFramesSentDuringKeydown,
    });
  });
  const terminalKeydownFrameCount = () => page.evaluate(() => (
    window as Window & { __muxdeckDesktopFocusTerminalFrames: string[] }
  ).__muxdeckDesktopFocusTerminalFrames.length);

  const shell = page.locator(".console-shell");
  const terminalStage = page.locator(".terminal-stage");
  const terminalElement = page.locator(".terminal-host .xterm");
  const stagedInput = page.getByRole("textbox", { name: "Staged input" });
  const consoleBars = page.getByRole("group", { name: "Console bars" });
  const terminalShortcuts = page.getByRole("group", { name: "Terminal input shortcuts" });
  const enterFocus = consoleBars.getByRole("button", {
    name: "Enter desktop terminal focus",
  });
  await expect(enterFocus).toBeVisible();
  await expect(enterFocus).toHaveAttribute("aria-keyshortcuts", "Control+Shift+F");
  await expect(terminalShortcuts.getByRole("button", {
    name: "Enter desktop terminal focus",
  })).toHaveCount(0);
  await stagedInput.fill("desktop focus keeps this draft");

  const standardStageHeight = (await terminalStage.boundingBox())!.height;
  const standardPaneHeight = workspacePaneHeight(sessionName);
  const sessionIdentity = workspaceTmuxIdentity(sessionName);
  const socketCountBeforeFocus = terminalSocketCount;
  const urlBeforeFocus = page.url();
  const historyLengthBeforeFocus = await page.evaluate(() => window.history.length);
  await terminalElement.evaluate((element) => {
    Object.defineProperty(window, "__muxdeckDesktopFocusTerminal", { value: element });
  });

  const keydownFrameCountBeforeFocus = await terminalKeydownFrameCount();
  await page.keyboard.press("Control+Shift+F");
  await expect(shell).toHaveAttribute("data-desktop-focus", "true");
  await expect(page.locator(".xterm-helper-textarea")).toBeFocused();
  expect(await terminalKeydownFrameCount()).toBe(keydownFrameCountBeforeFocus);
  const exitFocus = page.getByRole("button", {
    name: "Exit desktop terminal focus",
  });
  const focusControls = page.getByRole("group", {
    name: "Desktop terminal focus controls",
  });
  const focusRedraw = focusControls.getByRole("button", {
    name: "Redraw terminal display",
  });
  const focusShortcuts = focusControls.locator(".desktop-terminal-focus-shortcuts");
  await expect(focusControls.getByRole("button")).toHaveCount(3);
  await expect(focusRedraw).toBeVisible();
  await expect(focusRedraw).toBeInViewport();
  await expect(focusShortcuts).toHaveAccessibleName("Show all buttons");
  await expect(focusShortcuts).toHaveAttribute("aria-expanded", "false");
  await expect(focusShortcuts).toHaveAttribute(
    "aria-controls",
    "muxdeck-terminal-shortcuts",
  );
  await expect(exitFocus).toBeVisible();
  await expect(exitFocus).toBeInViewport();
  await expect(exitFocus).toHaveAttribute("aria-pressed", "true");
  await expect(exitFocus).toHaveAttribute("aria-keyshortcuts", "Control+Shift+F");
  const exitBox = await exitFocus.boundingBox();
  expect(exitBox).not.toBeNull();
  expect(exitBox!.width).toBeGreaterThanOrEqual(64);
  expect(exitBox!.height).toBeGreaterThanOrEqual(36);
  await focusRedraw.click();
  await expect(shell).toHaveAttribute("data-desktop-focus", "true");
  await expect(page.locator(".xterm-helper-textarea")).toBeFocused();
  expect(terminalSocketCount).toBe(socketCountBeforeFocus);
  expect(workspaceTmuxIdentity(sessionName)).toBe(sessionIdentity);
  await expect(page.locator("button:visible")).toHaveCount(3);
  await expect(page.locator(".console-bar-toolbar")).toBeHidden();
  await expect(page.locator(".console-header")).toBeHidden();
  await expect(page.locator(".console-session-navigation")).toBeHidden();
  await expect(page.locator(".terminal-coordinate")).toBeHidden();
  await expect(page.locator(".input-dock")).toBeHidden();
  await expect(page.locator(".terminal-view-controls")).toBeHidden();

  const shortcutDock = page.locator(".input-dock");
  const shortcutStrip = page.getByRole("group", { name: "Terminal input shortcuts" });
  await focusShortcuts.click();
  await expect(shell).toHaveAttribute("data-desktop-focus-shortcuts", "true");
  await expect(focusShortcuts).toHaveAccessibleName("Hide all buttons");
  await expect(focusShortcuts).toHaveAttribute("aria-expanded", "true");
  await expect(shortcutDock).toBeVisible();
  await expect(shortcutDock).toHaveCSS("position", "absolute");
  const moveShortcutPanel = shortcutDock.getByRole("button", {
    name: "Move floating button panel",
  });
  await expect(moveShortcutPanel).toBeVisible();
  await expect(moveShortcutPanel).toHaveCSS("cursor", "grab");
  await expect(shortcutStrip.getByRole("button")).toHaveCount(21);
  await expect(shortcutStrip.getByRole("button", { name: "Raw terminal keyboard" }))
    .toBeVisible();
  await expect(shortcutStrip.getByRole("button", { name: "Edit title and tags" }))
    .toBeVisible();
  await expect(shortcutStrip.getByRole("button", { name: "Open snippets" }))
    .toBeVisible();
  await expect(shortcutStrip.getByRole("button", { name: "Paste to draft" }))
    .toBeInViewport();
  const floatingPanelGeometry = await page.evaluate(() => {
    const panel = document.querySelector<HTMLElement>(".input-dock")!
      .getBoundingClientRect();
    const stage = document.querySelector<HTMLElement>(".terminal-stage")!
      .getBoundingClientRect();
    return {
      panel: [panel.left, panel.top, panel.right, panel.bottom],
      stage: [stage.left, stage.top, stage.right, stage.bottom],
      viewport: [window.innerWidth, window.innerHeight],
    };
  });
  expect(floatingPanelGeometry.panel[0]).toBeGreaterThan(0);
  expect(floatingPanelGeometry.panel[1]).toBeGreaterThan(0);
  expect(floatingPanelGeometry.panel[2]).toBeLessThan(floatingPanelGeometry.viewport[0]);
  expect(floatingPanelGeometry.panel[3]).toBeLessThan(floatingPanelGeometry.viewport[1]);
  expect(floatingPanelGeometry.stage).toEqual([0, 0, 1440, 900]);

  const initialPanelBox = await shortcutDock.boundingBox();
  const moveHandleBox = await moveShortcutPanel.boundingBox();
  expect(initialPanelBox).not.toBeNull();
  expect(moveHandleBox).not.toBeNull();
  await page.mouse.move(
    moveHandleBox!.x + (moveHandleBox!.width / 2),
    moveHandleBox!.y + (moveHandleBox!.height / 2),
  );
  await page.mouse.down();
  await page.mouse.move(
    Math.max(1, moveHandleBox!.x - 100),
    moveHandleBox!.y - 160,
    { steps: 8 },
  );
  await page.mouse.up();
  await expect(page.locator("html")).not.toHaveClass(/desktop-focus-shortcuts-moving/);
  await expect.poll(async () => (await shortcutDock.boundingBox())!.x)
    .toBeLessThan(initialPanelBox!.x);
  const movedPanelBox = (await shortcutDock.boundingBox())!;
  expect(movedPanelBox.x).toBeGreaterThanOrEqual(11);
  expect(movedPanelBox.y).toBeGreaterThanOrEqual(11);
  expect(movedPanelBox.x + movedPanelBox.width).toBeLessThanOrEqual(1429);
  expect(movedPanelBox.y + movedPanelBox.height).toBeLessThanOrEqual(889);
  expect((await terminalStage.boundingBox())!.height).toBe(900);

  await moveShortcutPanel.focus();
  const xBeforeKeyboardMove = Number(await shell.evaluate((element) => (
    element.style.getPropertyValue("--desktop-focus-shortcuts-x").replace("px", "")
  )));
  await page.keyboard.press("ArrowRight");
  await expect.poll(() => shell.evaluate((element) => Number(
    element.style.getPropertyValue("--desktop-focus-shortcuts-x").replace("px", ""),
  ))).toBe(xBeforeKeyboardMove + 16);
  await page.keyboard.press("Enter");
  await expect.poll(() => shell.evaluate((element) => [
    element.style.getPropertyValue("--desktop-focus-shortcuts-x"),
    element.style.getPropertyValue("--desktop-focus-shortcuts-y"),
  ])).toEqual(["0px", "0px"]);
  await expect.poll(async () => (await shortcutDock.boundingBox())!.x)
    .toBeCloseTo(initialPanelBox!.x, 0);
  await expect.poll(async () => (await shortcutDock.boundingBox())!.y)
    .toBeCloseTo(initialPanelBox!.y, 0);

  const moreKeys = shortcutStrip.locator(".other-keys-toggle");
  await moreKeys.click();
  const otherKeys = page.getByRole("group", { name: "Other keys" });
  await expect(otherKeys).toBeVisible();
  await expect(otherKeys.getByRole("button")).toHaveCount(4);
  await expect(otherKeys.getByRole("button", { name: "Right" })).toBeInViewport();
  await moreKeys.click();
  await expect(otherKeys).toBeHidden();

  await focusShortcuts.click();
  await expect(shell).toHaveAttribute("data-desktop-focus-shortcuts", "false");
  await expect(focusShortcuts).toHaveAccessibleName("Show all buttons");
  await expect(shortcutDock).toBeHidden();
  await expect(page.locator(".xterm-helper-textarea")).toBeFocused();

  expect((await terminalStage.boundingBox())!.height).toBeGreaterThan(standardStageHeight);
  await expect.poll(() => workspacePaneHeight(sessionName)).toBeGreaterThan(standardPaneHeight);
  const focusedPaneHeight = workspacePaneHeight(sessionName);
  const focusedGeometry = await page.evaluate(() => {
    const rect = (selector: string) => document.querySelector<HTMLElement>(selector)!
      .getBoundingClientRect();
    const shellRect = rect(".console-shell");
    const viewRect = rect(".terminal-view");
    const stageRect = rect(".terminal-stage");
    const hostRect = rect(".terminal-host");
    return {
      shell: [shellRect.left, shellRect.top, shellRect.right, shellRect.bottom],
      view: [viewRect.left, viewRect.top, viewRect.right, viewRect.bottom],
      stage: [stageRect.left, stageRect.top, stageRect.right, stageRect.bottom],
      host: [hostRect.left, hostRect.top, hostRect.right, hostRect.bottom],
      stagePadding: getComputedStyle(document.querySelector(".terminal-stage")!).padding,
      hostPadding: getComputedStyle(document.querySelector(".terminal-host")!).padding,
      viewport: [0, 0, window.innerWidth, window.innerHeight],
      overflowFree: document.documentElement.scrollWidth <= window.innerWidth
        && document.documentElement.scrollHeight <= window.innerHeight,
    };
  });
  expect(focusedGeometry).toEqual({
    shell: [0, 0, 1440, 900],
    view: [0, 0, 1440, 900],
    stage: [0, 0, 1440, 900],
    host: [0, 0, 1440, 900],
    stagePadding: "0px",
    hostPadding: "0px",
    viewport: [0, 0, 1440, 900],
    overflowFree: true,
  });
  expect(await terminalElement.evaluate((element) => (
    element === (window as Window & { __muxdeckDesktopFocusTerminal: Element })
      .__muxdeckDesktopFocusTerminal
  ))).toBe(true);
  expect(terminalSocketCount).toBe(socketCountBeforeFocus);
  expect(workspaceTmuxIdentity(sessionName)).toBe(sessionIdentity);
  expect(page.url()).toBe(urlBeforeFocus);
  expect(await page.evaluate(() => window.history.length)).toBe(historyLengthBeforeFocus);
  await page.screenshot({ path: "artifacts/terminal-desktop-focus.png" });

  await exitFocus.click();
  await expect(shell).toHaveAttribute("data-desktop-focus", "false");
  await expect(page.locator(".xterm-helper-textarea")).toBeFocused();
  await expect(enterFocus).toBeVisible();
  await expect(page.locator(".console-header")).toBeVisible();
  await expect(stagedInput).toHaveValue("desktop focus keeps this draft");
  await expect.poll(() => workspacePaneHeight(sessionName)).toBeLessThan(focusedPaneHeight);
  expect(await terminalElement.evaluate((element) => (
    element === (window as Window & { __muxdeckDesktopFocusTerminal: Element })
      .__muxdeckDesktopFocusTerminal
  ))).toBe(true);
  expect(terminalSocketCount).toBe(socketCountBeforeFocus);
  expect(workspaceTmuxIdentity(sessionName)).toBe(sessionIdentity);
  expect(page.url()).toBe(urlBeforeFocus);
  expect(await page.evaluate(() => window.history.length)).toBe(historyLengthBeforeFocus);

  const keydownFrameCountBeforeReenter = await terminalKeydownFrameCount();
  await page.keyboard.press("Control+Shift+F");
  await expect(shell).toHaveAttribute("data-desktop-focus", "true");
  await expect(page.locator(".xterm-helper-textarea")).toBeFocused();
  expect(await terminalKeydownFrameCount()).toBe(keydownFrameCountBeforeReenter);
  const keydownFrameCountBeforeExit = await terminalKeydownFrameCount();
  await page.keyboard.press("Control+Shift+F");
  await expect(shell).toHaveAttribute("data-desktop-focus", "false");
  await expect(page.locator(".xterm-helper-textarea")).toBeFocused();
  expect(await terminalKeydownFrameCount()).toBe(keydownFrameCountBeforeExit);

  await enterFocus.click();
  await expect(shell).toHaveAttribute("data-desktop-focus", "true");
  await page.setViewportSize({ width: 390, height: 700 });
  await expect(shell).toHaveAttribute("data-desktop-focus", "false");
  await expect(exitFocus).toBeHidden();
  await expect(page.getByRole("navigation", { name: "Mobile console focus" })).toBeVisible();
  expect(terminalSocketCount).toBe(socketCountBeforeFocus);
  expect(workspaceTmuxIdentity(sessionName)).toBe(sessionIdentity);
  expect(page.url()).toBe(urlBeforeFocus);
});

test("desktop tabs switch to a persistent vertical rail without reconnecting", async ({
  page,
}) => {
  test.setTimeout(45_000);
  const railSession = `${sessionName}-vertical-tabs`;
  execFileSync("tmux", [
    ...tmux,
    "new-session",
    "-d",
    "-s",
    railSession,
    "bash",
    "--noprofile",
    "--norc",
  ]);

  let terminalSocketCount = 0;
  page.on("websocket", (socket) => {
    if (socket.url().includes("/ws/terminal")) terminalSocketCount += 1;
  });

  try {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(
      `/mux/session/${sessionName}?tab=${encodeURIComponent(sessionName)}`
      + `&tab=${encodeURIComponent(railSession)}`,
    );
    await expect(page.locator(".connection-badge")).toContainText("Live", {
      timeout: 10_000,
    });
    await expect.poll(() => terminalSocketCount).toBe(1);

    const shell = page.locator(".console-shell");
    const navigation = page.getByRole("navigation", { name: "Session workspace" });
    const tabList = page.getByRole("tablist", { name: "Session workspace tabs" });
    const terminal = page.locator(".terminal-host .xterm");
    const consoleBars = page.getByRole("group", { name: "Console bars" });
    const sessionTabsToggle = consoleBars.getByRole("button", {
      name: "Session tabs",
      exact: true,
    });
    const orientationToggle = consoleBars
      .getByRole("button", { name: "Vertical session tabs" });
    await terminal.evaluate((element) => {
      Object.defineProperty(window, "__muxdeckVerticalTabsTerminal", { value: element });
    });

    await expect(shell).toHaveAttribute("data-desktop-tabs", "horizontal");
    await expect(page.locator("#muxdeck-session-tabs"))
      .toHaveAttribute("data-orientation", "horizontal");
    await expect(page.locator("#muxdeck-session-tabs .workspace-tab-list"))
      .toHaveAttribute("aria-orientation", "horizontal");
    await expect(orientationToggle).toHaveAttribute("aria-pressed", "false");
    const horizontalNavigationBox = await navigation.boundingBox();
    expect(horizontalNavigationBox).not.toBeNull();
    expect(horizontalNavigationBox!.width).toBeGreaterThan(1200);
    expect(horizontalNavigationBox!.height).toBeLessThan(70);

    const socketCountBeforeLayoutChange = terminalSocketCount;
    await orientationToggle.click();
    await expect(shell).toHaveAttribute("data-desktop-tabs", "vertical");
    await expect(navigation).toHaveAttribute("data-orientation", "vertical");
    await expect(tabList).toHaveAttribute("aria-orientation", "vertical");
    await expect(orientationToggle).toHaveAttribute("aria-pressed", "true");
    await expect.poll(() => page.evaluate(() => (
      window.localStorage.getItem("muxdeck-desktop-tab-orientation")
    ))).toBe("vertical");

    await expect(sessionTabsToggle)
      .toHaveAttribute("aria-keyshortcuts", "Control+Shift+S");
    await terminal.click();
    await page.keyboard.press("Control+Shift+S");
    await expect(shell).toHaveAttribute("data-session-tabs-visible", "false");
    await expect(sessionTabsToggle).toHaveAttribute("aria-pressed", "false");
    await expect(navigation).toBeHidden();
    await page.keyboard.press("Control+Shift+S");
    await expect(shell).toHaveAttribute("data-session-tabs-visible", "true");
    await expect(sessionTabsToggle).toHaveAttribute("aria-pressed", "true");
    await expect(navigation).toBeVisible();
    expect(terminalSocketCount).toBe(socketCountBeforeLayoutChange);

    const verticalNavigationBox = await navigation.boundingBox();
    const terminalViewBox = await page.locator(".terminal-view").boundingBox();
    const toolbarBox = await page.locator(".console-bar-toolbar").boundingBox();
    const resizeHandle = page.getByRole("separator", {
      name: "Resize vertical session tabs",
    });
    expect(verticalNavigationBox).not.toBeNull();
    expect(terminalViewBox).not.toBeNull();
    expect(toolbarBox).not.toBeNull();
    expect(verticalNavigationBox!.width).toBeGreaterThanOrEqual(232);
    expect(verticalNavigationBox!.width).toBeLessThanOrEqual(321);
    expect(verticalNavigationBox!.height).toBeGreaterThan(700);
    expect(verticalNavigationBox!.y).toBeGreaterThanOrEqual(toolbarBox!.height - 1);
    expect(terminalViewBox!.x).toBeGreaterThanOrEqual(
      verticalNavigationBox!.x + verticalNavigationBox!.width - 1,
    );
    expect(await terminal.evaluate((element) => (
      element === (window as Window & { __muxdeckVerticalTabsTerminal: Element })
        .__muxdeckVerticalTabsTerminal
    ))).toBe(true);
    expect(terminalSocketCount).toBe(socketCountBeforeLayoutChange);

    await expect(resizeHandle).toBeVisible();
    await expect(resizeHandle).toHaveAttribute("aria-valuenow", "288");
    const resizeHandleBox = await resizeHandle.boundingBox();
    expect(resizeHandleBox).not.toBeNull();
    expect(resizeHandleBox!.width).toBeGreaterThanOrEqual(44);

    const resizeStartX = resizeHandleBox!.x + resizeHandleBox!.width / 2;
    const resizeY = resizeHandleBox!.y + resizeHandleBox!.height / 2;
    await page.mouse.move(resizeStartX, resizeY);
    await page.mouse.down();
    await page.mouse.move(resizeStartX - 400, resizeY, { steps: 4 });
    await expect.poll(async () => (await navigation.boundingBox())?.width).toBe(72);
    await expect(navigation).toHaveAttribute("data-compact", "true");
    await expect(resizeHandle).toHaveAttribute("aria-valuenow", "72");
    expect(await page.evaluate(() => (
      window.localStorage.getItem("muxdeck-desktop-tab-rail-width")
    ))).toBeNull();

    const firstCompactTab = page.locator(".workspace-tab").first();
    await expect(firstCompactTab.getByRole("tab")).toBeVisible();
    await expect(firstCompactTab.locator(".workspace-tab-title")).toBeHidden();
    await expect(firstCompactTab.locator(".workspace-tab-compact-index"))
      .toHaveAttribute("data-index", "1");
    await expect(firstCompactTab.locator(".workspace-tab-compact-index")).toBeVisible();
    await expect(firstCompactTab.locator(".workspace-tab-reorder")).toBeHidden();
    await expect(firstCompactTab.locator(".workspace-tab-terminate")).toBeHidden();
    await expect(firstCompactTab.locator(".workspace-tab-close")).toBeHidden();
    await expect(page.locator(".workspace-dashboard-button > span")).toBeHidden();
    await expect(page.locator(".workspace-dashboard-button svg")).toBeVisible();
    await expect(page.locator(".workspace-new-session-button > span")).toBeHidden();
    await expect(page.locator(".workspace-save-button .workspace-identity-copy")).toBeHidden();
    await expect(page.locator(".workspace-tab-search-button > span")).toBeHidden();
    await expect(page.locator(".workspace-recents-button > span")).toBeHidden();
    expect(await terminal.evaluate((element) => (
      element === (window as Window & { __muxdeckVerticalTabsTerminal: Element })
        .__muxdeckVerticalTabsTerminal
    ))).toBe(true);
    expect(terminalSocketCount).toBe(socketCountBeforeLayoutChange);
    await page.screenshot({ path: "artifacts/workspace-vertical-tabs-compact.png" });

    await page.mouse.up();
    await expect.poll(() => page.evaluate(() => (
      window.localStorage.getItem("muxdeck-desktop-tab-rail-width")
    ))).toBe("72");

    await resizeHandle.press("Enter");
    await expect(navigation).not.toHaveAttribute("data-compact");
    await expect(resizeHandle).toHaveAttribute("aria-valuenow", "288");
    await expect(page.locator(".workspace-dashboard-button > span")).toBeVisible();
    await expect(firstCompactTab.locator(".workspace-tab-title")).toBeVisible();
    await expect(firstCompactTab.locator(".workspace-tab-compact-index")).toBeHidden();
    await expect.poll(() => page.evaluate(() => (
      window.localStorage.getItem("muxdeck-desktop-tab-rail-width")
    ))).toBe("288");

    await page.mouse.move(resizeStartX, resizeY);
    await page.mouse.down();
    await page.mouse.move(resizeStartX + 72, resizeY, { steps: 4 });
    await expect.poll(async () => (await navigation.boundingBox())?.width).toBe(360);
    expect(await page.evaluate(() => (
      window.localStorage.getItem("muxdeck-desktop-tab-rail-width")
    ))).toBe("288");
    await page.mouse.up();
    await expect.poll(() => page.evaluate(() => (
      window.localStorage.getItem("muxdeck-desktop-tab-rail-width")
    ))).toBe("360");
    await expect(resizeHandle).toHaveAttribute("aria-valuenow", "360");
    expect(await terminal.evaluate((element) => (
      element === (window as Window & { __muxdeckVerticalTabsTerminal: Element })
        .__muxdeckVerticalTabsTerminal
    ))).toBe(true);
    expect(terminalSocketCount).toBe(socketCountBeforeLayoutChange);

    await resizeHandle.press("Shift+ArrowRight");
    await expect(resizeHandle).toHaveAttribute("aria-valuenow", "392");
    await expect.poll(() => page.evaluate(() => (
      window.localStorage.getItem("muxdeck-desktop-tab-rail-width")
    ))).toBe("392");
    await expect.poll(async () => (await navigation.boundingBox())?.width).toBe(392);
    expect(terminalSocketCount).toBe(socketCountBeforeLayoutChange);
    await page.screenshot({ path: "artifacts/workspace-vertical-tabs.png" });

    const activeTab = page.getByRole("tab", { name: new RegExp(`^${sessionName},`) });
    const railTab = page.getByRole("tab", { name: new RegExp(`^${railSession},`) });
    await activeTab.focus();
    await activeTab.press("ArrowDown");
    await expect(railTab).toBeFocused();
    await railTab.press("ArrowRight");
    await expect(railTab).toBeFocused();

    await page.getByRole("button", { name: `Move ${railSession} tab up` }).click();
    await expectRoute(page, `/mux/session/${sessionName}`, [railSession, sessionName]);
    await expect(page.getByRole("button", {
      name: `Move ${railSession} tab down`,
    })).toBeFocused();
    expect(terminalSocketCount).toBe(socketCountBeforeLayoutChange);

    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.locator(".connection-badge")).toContainText("Live", {
      timeout: 10_000,
    });
    await expect(shell).toHaveAttribute("data-desktop-tabs", "vertical");
    await expect(navigation).toHaveAttribute("data-orientation", "vertical");
    await expect(resizeHandle).toHaveAttribute("aria-valuenow", "392");
    await expect.poll(async () => (await navigation.boundingBox())?.width).toBe(392);
    await expectRoute(page, `/mux/session/${sessionName}`, [railSession, sessionName]);

    await page.getByRole("button", { name: "New session", exact: true }).click();
    const newSessionScreen = page.locator(".new-session-screen");
    await expect(newSessionScreen).toHaveAttribute("data-desktop-tabs", "vertical");
    await expect(navigation).toHaveAttribute("data-orientation", "vertical");
    const newSessionRailBox = await navigation.boundingBox();
    const newSessionPanelBox = await page.locator(".new-session-panel").boundingBox();
    expect(newSessionRailBox).not.toBeNull();
    expect(newSessionPanelBox).not.toBeNull();
    expect(newSessionRailBox!.width).toBe(392);
    expect(newSessionPanelBox!.x).toBeGreaterThanOrEqual(
      newSessionRailBox!.x + newSessionRailBox!.width - 1,
    );
    await page.getByRole("button", { name: "Cancel" }).click();
    await expectRoute(page, `/mux/session/${sessionName}`, [railSession, sessionName]);
    await expect(page.locator(".connection-badge")).toContainText("Live", {
      timeout: 10_000,
    });

    await page.setViewportSize({ width: 390, height: 700 });
    await expect(page.getByRole("navigation", { name: "Mobile console focus" })).toBeVisible();
    await expect(page.locator("#muxdeck-session-tabs"))
      .toHaveAttribute("data-orientation", "horizontal");
    await expect(page.locator("#muxdeck-session-tabs .workspace-tab-list"))
      .toHaveAttribute("aria-orientation", "horizontal");
    await expect(resizeHandle).toBeHidden();
    await expect(page.getByRole("button", {
      name: "Enter distraction-free terminal",
    })).toBeVisible();
    await expect(page.locator(".console-bar-toolbar")).toBeHidden();
  } finally {
    try {
      execFileSync("tmux", [...tmux, "kill-session", "-t", `=${railSession}`], {
        stdio: "ignore",
      });
    } catch {
      // Cleanup stays scoped to the disposable test tmux server.
    }
  }
});

test("desktop workspace shortcuts cycle, jump by number, and search tabs", async ({
  page,
  request,
}) => {
  const shortcutSession = `${sessionName}-shortcut-search`;
  const shortcutTitle = "Emerald deploy lane";
  execFileSync("tmux", [
    ...tmux,
    "new-session",
    "-d",
    "-s",
    shortcutSession,
    "bash",
    "--noprofile",
    "--norc",
  ]);

  try {
    const titleResponse = await request.put("/mux/api/session-title", {
      data: { session: shortcutSession, title: shortcutTitle },
    });
    expect(titleResponse.ok()).toBe(true);

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(
      `/mux/session/${sessionName}?tab=${encodeURIComponent(sessionName)}`
      + `&tab=${encodeURIComponent(shortcutSession)}`,
    );
    await expect(page.locator(".connection-badge")).toContainText("Live", {
      timeout: 10_000,
    });

    const tabSearchButton = page.getByRole("button", { name: "Search open tabs" });
    await expect(tabSearchButton).toBeVisible();
    await expect(tabSearchButton).toHaveAttribute("aria-keyshortcuts", "Control+Shift+;");

    await page.evaluate(() => {
      const framesSentDuringKeydown: string[] = [];
      let handlingKeydown = false;
      const nativeSend = WebSocket.prototype.send;
      window.addEventListener("keydown", () => {
        handlingKeydown = true;
        window.queueMicrotask(() => {
          handlingKeydown = false;
        });
      }, { capture: true });
      WebSocket.prototype.send = function send(data) {
        let isResize = false;
        if (typeof data === "string") {
          try {
            isResize = JSON.parse(data).type === "resize";
          } catch {
            // A plain string is terminal input, not a JSON control frame.
          }
        }
        if (handlingKeydown && this.url.includes("/ws/terminal") && !isResize) {
          framesSentDuringKeydown.push(this.url);
        }
        return nativeSend.call(this, data);
      };
      Object.defineProperty(window, "__muxdeckKeydownTerminalFrames", {
        value: framesSentDuringKeydown,
      });
    });
    const keydownTerminalFrameCount = () => page.evaluate(() => (
      window as Window & { __muxdeckKeydownTerminalFrames: string[] }
    ).__muxdeckKeydownTerminalFrames.length);

    const terminalInput = page.locator(".xterm-helper-textarea");
    const desktopShortcutStrip = page.getByRole("group", {
      name: "Terminal input shortcuts",
    });
    const desktopLiveButton = desktopShortcutStrip.getByRole("button", {
      name: "Focus live terminal input",
    });
    const desktopFocusButton = page.getByRole("group", { name: "Console bars" }).getByRole("button", {
      name: "Enter desktop terminal focus",
    });
    await expect(desktopLiveButton).toBeVisible();
    await expect(desktopFocusButton).toBeVisible();
    await expect(desktopLiveButton).toHaveText("Live");
    await page.getByRole("textbox", { name: "Staged input" }).focus();
    await desktopLiveButton.click();
    await expect(terminalInput).toBeFocused();

    await terminalInput.focus();
    const terminalInputFrameCountBefore = await keydownTerminalFrameCount();
    await page.keyboard.press("Control+Shift+2");
    await expectRoute(
      page,
      `/mux/session/${shortcutSession}`,
      [sessionName, shortcutSession],
    );
    expect(await keydownTerminalFrameCount()).toBe(terminalInputFrameCountBefore);
    await page.keyboard.press("Control+Shift+1");
    await expectRoute(
      page,
      `/mux/session/${sessionName}`,
      [sessionName, shortcutSession],
    );
    await page.keyboard.press("Control+Shift+9");
    await expectRoute(
      page,
      `/mux/session/${sessionName}`,
      [sessionName, shortcutSession],
    );
    expect(await keydownTerminalFrameCount()).toBe(terminalInputFrameCountBefore);

    await page.keyboard.press("Control+Shift+.");
    await expectRoute(
      page,
      `/mux/session/${shortcutSession}`,
      [sessionName, shortcutSession],
    );
    expect(await keydownTerminalFrameCount()).toBe(terminalInputFrameCountBefore);

    // Workspace switching remains global while the terminal composer owns focus.
    const stagedInput = page.getByRole("textbox", { name: "Staged input" });
    const desktopComposerActions = page.locator(".composer-actions-primary");
    expect(await desktopComposerActions.locator(".composer-action-label-full").allTextContents())
      .toEqual(["Clear", "Send", "Send + Enter", "Queue in memo", "Send + Tab"]);
    for (const label of await desktopComposerActions.locator(
      ".composer-action-label-full",
    ).all()) {
      await expect(label).toBeVisible();
    }
    for (const label of await desktopComposerActions.locator(
      ".composer-action-label-compact",
    ).all()) {
      await expect(label).toBeHidden();
    }
    await stagedInput.fill("draft stays with its session");
    await stagedInput.press("Control+/");
    await stagedInput.press("Control+Shift+/");
    await expect(stagedInput).toHaveValue("draft stays with its session");
    await expectRoute(
      page,
      `/mux/session/${shortcutSession}`,
      [sessionName, shortcutSession],
    );
    await page.keyboard.press("Control+Shift+,");
    await expectRoute(
      page,
      `/mux/session/${sessionName}`,
      [sessionName, shortcutSession],
    );

    // The chord must be exact so related editor/browser shortcuts remain untouched.
    await page.keyboard.press("Control+Alt+Shift+.");
    await expectRoute(
      page,
      `/mux/session/${sessionName}`,
      [sessionName, shortcutSession],
    );

    await page.keyboard.press("Control+Shift+;");
    let jumpDialog = page.getByRole("dialog", { name: "Jump to tab" });
    await expect(jumpDialog).toBeVisible();
    let tabSearch = jumpDialog.getByRole("combobox", {
      name: "Search open tabs by title or tmux name",
    });
    await expect(tabSearch).toBeFocused();
    await tabSearch.fill("emerald deploy");
    await page.screenshot({ path: "artifacts/tab-search-desktop.png" });
    await tabSearch.press("Enter");
    await expectRoute(
      page,
      `/mux/session/${shortcutSession}`,
      [sessionName, shortcutSession],
    );
    await expect(jumpDialog).toBeHidden();

    await tabSearchButton.click();
    jumpDialog = page.getByRole("dialog", { name: "Jump to tab" });
    tabSearch = jumpDialog.getByRole("combobox", {
      name: "Search open tabs by title or tmux name",
    });
    await tabSearch.fill(sessionName);
    await expect(
      jumpDialog.locator('[role="option"][aria-selected="true"] strong'),
    ).toHaveText(sessionName);
    await tabSearch.press("Enter");
    await expectRoute(
      page,
      `/mux/session/${sessionName}`,
      [sessionName, shortcutSession],
    );

    // Any modal takes priority over global workspace chords.
    await page.keyboard.press("Control+Shift+;");
    jumpDialog = page.getByRole("dialog", { name: "Jump to tab" });
    await expect(jumpDialog).toBeVisible();
    await page.keyboard.press("Control+Shift+.");
    await expectRoute(
      page,
      `/mux/session/${sessionName}`,
      [sessionName, shortcutSession],
    );
    await expect(jumpDialog).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(jumpDialog).toBeHidden();

    const keymapTrigger = page.getByRole("button", { name: "Show desktop keymap" });
    await expect(keymapTrigger).toBeVisible();
    await keymapTrigger.click();
    const keymap = page.getByRole("dialog", { name: "Desktop workspace keymap" });
    await expect(keymap).toBeVisible();
    for (const shortcut of [
      "Ctrl+Shift+E",
      "Ctrl+Shift+L",
      "Ctrl+Shift+C",
      "Ctrl+Shift+A",
      "Ctrl+Shift+U",
      "Ctrl+Shift+D",
      "Ctrl+Shift+S",
      "Ctrl+Shift+F",
    ]) {
      await expect(keymap.getByText(shortcut, { exact: true })).toBeVisible();
    }
    await page.screenshot({ path: "artifacts/workspace-keymap-desktop.png" });
    await page.keyboard.press("Escape");
    await expect(keymap).toBeHidden();

    const shell = page.locator(".console-shell");
    const actionsToggle = page.getByRole("button", { name: "Tab action buttons" });
    const copyToggle = page.getByRole("button", { name: "Browser terminal copy mode" });
    await expect(actionsToggle).toHaveAttribute("aria-keyshortcuts", "Control+Shift+A");
    await expect(copyToggle).toHaveAttribute("aria-keyshortcuts", "Control+Shift+C");
    await page.keyboard.press("Control+Shift+A");
    await expect(actionsToggle).toHaveAttribute("aria-pressed", "false");
    await page.keyboard.press("Control+Shift+C");
    await expect(shell).toHaveAttribute("data-desktop-copy-mode", "true");

    const desktopRawPageUp = desktopShortcutStrip.getByRole("button", { name: "PgUp" });
    const desktopTmuxPageUp = desktopShortcutStrip.getByRole("button", {
      name: "Tmux Page Up",
    });
    await expect(shell).toHaveAttribute("data-scroll-agent", "shells");
    await expect(shell).toHaveAttribute("data-scroll-mode", "tmux");
    await expect(desktopTmuxPageUp).toHaveClass(/preferred-scroll-key/);
    await expect(desktopTmuxPageUp).toHaveAttribute(
      "aria-keyshortcuts",
      "Control+Shift+U",
    );
    await expect(desktopRawPageUp).not.toHaveClass(/preferred-scroll-key/);

    const paneInMode = () => execFileSync(
      "tmux",
      [...tmux, "display-message", "-p", "-t", paneId, "#{pane_in_mode}"],
      { encoding: "utf8" },
    ).trim();
    await page.keyboard.press("Control+Shift+U");
    await expect.poll(paneInMode).toBe("1");
    await page.keyboard.press("Control+Shift+D");
    await page.keyboard.press("Control+Shift+L");
    await expect.poll(paneInMode).toBe("0");

    await desktopRawPageUp.click();
    await expect(shell).toHaveAttribute("data-scroll-mode", "application");
    await expect(desktopRawPageUp).toHaveClass(/preferred-scroll-key/);
    await expect(desktopRawPageUp).toHaveAttribute(
      "aria-keyshortcuts",
      "Control+Shift+U",
    );
    await expect(desktopTmuxPageUp).not.toHaveClass(/preferred-scroll-key/);
    await expect.poll(() => page.evaluate(() => (
      JSON.parse(window.localStorage.getItem("muxdeck-agent-scroll-preferences") || "{}")
        .shells
    ))).toBe("application");
    await page.keyboard.press("Control+Shift+U");
    await expect.poll(paneInMode).toBe("0");

    const identityBeforeEndShortcut = workspaceTmuxIdentity(sessionName);
    await page.keyboard.press("Control+Shift+E");
    const endDialog = page.getByRole("alertdialog", { name: "Terminate tmux session?" });
    await expect(endDialog).toBeVisible();
    expect(workspaceTmuxIdentity(sessionName)).toBe(identityBeforeEndShortcut);
    await endDialog.getByRole("button", { name: "Cancel" }).click();
    await expect(endDialog).toBeHidden();
    await page.keyboard.press("Control+Shift+C");
    await expect(shell).toHaveAttribute("data-desktop-copy-mode", "false");
    await page.keyboard.press("Control+Shift+A");
    await expect(actionsToggle).toHaveAttribute("aria-pressed", "true");

    await page.setViewportSize({ width: 390, height: 700 });
    await expect(tabSearchButton).toBeHidden();
    await expect(keymapTrigger).toBeHidden();
    await expect(desktopLiveButton).toBeHidden();
    await expect(desktopFocusButton).toBeHidden();
    await page.keyboard.press("Control+Shift+.");
    await expectRoute(
      page,
      `/mux/session/${sessionName}`,
      [sessionName, shortcutSession],
    );
    await page.keyboard.press("Control+Shift+2");
    await expectRoute(
      page,
      `/mux/session/${sessionName}`,
      [sessionName, shortcutSession],
    );
    await page.keyboard.press("Control+Shift+;");
    await expect(page.getByRole("dialog", { name: "Jump to tab" })).toBeHidden();
  } finally {
    try {
      execFileSync("tmux", [...tmux, "kill-session", "-t", `=${shortcutSession}`], {
        stdio: "ignore",
      });
    } catch {
      // Cleanup remains scoped to this test's disposable tmux server.
    }
  }
});

test("workspace tabs reorder on desktop and mobile, update the URL, and survive reload", async ({ page }) => {
  test.setTimeout(60_000);
  const secondSession = `${sessionName}-reorder-second`;
  const thirdSession = `${sessionName}-reorder-third`;
  const initialTabs = [sessionName, secondSession, thirdSession];
  const reorderedTabs = [sessionName, thirdSession, secondSession];

  for (const helperSession of [secondSession, thirdSession]) {
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
  }

  try {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(
      `/mux/session/${secondSession}?kind=shells&view=list`
      + initialTabs.map((tab) => `&tab=${encodeURIComponent(tab)}`).join(""),
    );
    await expect(page.locator(".connection-badge")).toContainText("Live", {
      timeout: 10_000,
    });

    const visibleTabs = page.locator("#muxdeck-session-tabs [role='tab']");
    await expect(visibleTabs).toHaveText(initialTabs);

    const moveThirdLeft = page.getByRole("button", {
      name: `Move ${thirdSession} tab left`,
    });
    await moveThirdLeft.click();
    await expect(moveThirdLeft).toBeFocused();
    await expect(visibleTabs).toHaveText(reorderedTabs);
    await expectRoute(
      page,
      `/mux/session/${secondSession}`,
      reorderedTabs,
      { kind: "shells", view: "list" },
    );
    await expect(page.getByRole("tab", {
      name: new RegExp(`^${secondSession},`),
    })).toHaveAttribute("aria-selected", "true");

    await page.reload({ waitUntil: "domcontentloaded" });
    await expectRoute(
      page,
      `/mux/session/${secondSession}`,
      reorderedTabs,
      { kind: "shells", view: "list" },
    );
    await expect(visibleTabs).toHaveText(reorderedTabs);

    await page.setViewportSize({ width: 390, height: 664 });
    await page.getByRole("navigation", { name: "Mobile console focus" })
      .getByRole("button", { name: "Overview" })
      .click();
    await page.getByRole("button", { name: `Move ${thirdSession} tab up` }).click();
    await expect(page.getByRole("button", {
      name: `Move ${thirdSession} tab down`,
    })).toBeFocused();
    const mobileReorderedTabs = [thirdSession, sessionName, secondSession];
    await expectRoute(
      page,
      `/mux/session/${secondSession}/recents`,
      mobileReorderedTabs,
      { kind: "shells", view: "list" },
    );
    await page.goBack();
    await expectRoute(
      page,
      `/mux/session/${secondSession}`,
      mobileReorderedTabs,
      { kind: "shells", view: "list" },
    );
  } finally {
    for (const helperSession of [secondSession, thirdSession]) {
      try {
        execFileSync("tmux", [...tmux, "kill-session", "-t", `=${helperSession}`], {
          stdio: "ignore",
        });
      } catch {
        // Cleanup stays scoped to sessions created on this test's disposable socket.
      }
    }
  }
});

test("workspace tabs copy and move into isolated browser windows", async ({ browser, page }) => {
  test.setTimeout(60_000);
  const helperSession = `${sessionName}-window-actions`;
  const sourceTabs = [sessionName, helperSession];
  const sourceGroup = encodeURIComponent(JSON.stringify({
    id: "window_actions",
    name: "Window actions",
    color: "cyan",
    collapsed: false,
    tabs: sourceTabs,
  }));
  let copiedPage: Page | null = null;
  let movedPage: Page | null = null;

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
  const primaryIdentity = workspaceTmuxIdentity(sessionName);
  const helperIdentity = workspaceTmuxIdentity(helperSession);

  try {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(
      `/mux/session/${encodeURIComponent(helperSession)}?kind=shells&view=list`
      + sourceTabs.map((tab) => `&tab=${encodeURIComponent(tab)}`).join("")
      + `&tab-group=${sourceGroup}`,
    );
    await expect(page.locator(".connection-badge")).toContainText("Live", {
      timeout: 10_000,
    });

    const [openedCopy] = await Promise.all([
      page.context().waitForEvent("page"),
      page.getByRole("button", {
        name: `Copy ${helperSession} tab to new window`,
      }).click(),
    ]);
    copiedPage = openedCopy;
    await expectRoute(
      copiedPage,
      `/mux/session/${helperSession}`,
      [helperSession],
      { kind: "shells", view: "list" },
    );
    expect(await copiedPage.evaluate(() => window.opener === null)).toBe(true);
    expect(new URL(copiedPage.url()).searchParams.has("workspace")).toBe(false);
    expect(new URL(copiedPage.url()).searchParams.has("tab-group")).toBe(false);
    await expectRoute(
      page,
      `/mux/session/${helperSession}`,
      sourceTabs,
      { kind: "shells", view: "list" },
    );
    await expect(page.locator("#muxdeck-session-tabs .workspace-tab")).toHaveCount(2);
    expect(workspaceTmuxIdentity(helperSession)).toBe(helperIdentity);
    await copiedPage.close();
    copiedPage = null;

    await page.evaluate(() => {
      const testWindow = window as typeof window & {
        __muxdeckOriginalOpen?: typeof window.open;
      };
      testWindow.__muxdeckOriginalOpen = window.open;
      window.open = (() => null) as typeof window.open;
    });
    await page.getByRole("button", {
      name: `Copy ${helperSession} tab to new window`,
    }).click();
    const blockedAlert = page.getByRole("alert");
    await expect(blockedAlert).toBeVisible();
    await blockedAlert.locator("span").evaluate((message) => {
      message.textContent = `Muxdeck could not open ${"unbroken-title-".repeat(18)}.`;
    });
    expect(await blockedAlert.evaluate((alert) => alert.scrollWidth <= alert.clientWidth))
      .toBe(true);
    await page.getByRole("button", { name: "Dismiss new window error" }).click();
    await page.evaluate(() => {
      const testWindow = window as typeof window & {
        __muxdeckOriginalOpen?: typeof window.open;
      };
      if (testWindow.__muxdeckOriginalOpen) {
        window.open = testWindow.__muxdeckOriginalOpen;
        delete testWindow.__muxdeckOriginalOpen;
      }
    });

    const touchContext = await browser.newContext({
      hasTouch: true,
      viewport: { width: 1366, height: 900 },
    });
    try {
      const touchPage = await touchContext.newPage();
      await touchPage.goto(page.url());
      await touchPage.evaluate(() => {
        window.localStorage.setItem("muxdeck-desktop-tab-orientation", "vertical");
        window.localStorage.setItem("muxdeck-desktop-tab-rail-width", "288");
      });
      await touchPage.reload({ waitUntil: "domcontentloaded" });
      expect(await touchPage.evaluate(() => window.matchMedia("(pointer: coarse)").matches))
        .toBe(true);
      const touchNavigation = touchPage.getByRole("navigation", {
        name: "Session workspace",
      });
      await expect(touchNavigation).toHaveAttribute("data-orientation", "vertical");
      const touchHelperTab = touchNavigation.locator(
        `.workspace-tab[data-workspace-session-name="${helperSession}"]`,
      );
      await expect(touchHelperTab.locator(".workspace-tab-window-actions")).toBeHidden();
      const touchGeometry = await touchHelperTab.evaluate((tab) => {
        const tabRect = tab.getBoundingClientRect();
        const titleRect = tab.querySelector(".workspace-tab-title")!.getBoundingClientRect();
        const closeRect = tab.querySelector(".workspace-tab-close")!.getBoundingClientRect();
        return {
          closeRight: closeRect.right,
          tabRight: tabRect.right,
          titleWidth: titleRect.width,
        };
      });
      expect(touchGeometry.closeRight).toBeLessThanOrEqual(
        touchGeometry.tabRight + CSS_PIXEL_TOLERANCE,
      );
      expect(touchGeometry.titleWidth).toBeGreaterThan(0);

      await touchPage.getByRole("button", { name: /Open session switcher/ }).click();
      const touchOverview = touchPage.getByRole("dialog", { name: "Switch sessions" });
      const touchHelperRow = touchOverview.locator(
        `.workspace-session-row[data-workspace-session-name="${helperSession}"]`,
      );
      await expect(touchHelperRow.getByRole("button", {
        name: `Move ${helperSession} tab to new window`,
      })).toBeVisible();
      await expect(touchHelperRow.getByRole("button", {
        name: `Copy ${helperSession} tab to new window`,
      })).toBeVisible();
    } finally {
      await touchContext.close();
    }

    await page.evaluate(() => {
      window.localStorage.setItem("muxdeck-desktop-tab-orientation", "vertical");
      window.localStorage.setItem("muxdeck-desktop-tab-rail-width", "72");
    });
    await page.reload({ waitUntil: "domcontentloaded" });
    const navigation = page.getByRole("navigation", { name: "Session workspace" });
    await expect(navigation).toHaveAttribute("data-orientation", "vertical");
    await expect(navigation).toHaveAttribute("data-compact", "true");
    const helperTab = navigation.locator(
      `.workspace-tab[data-workspace-session-name="${helperSession}"]`,
    );
    await expect(helperTab.locator(".workspace-tab-window-actions")).toBeHidden();

    await page.getByRole("button", { name: /Open session switcher/ }).click();
    let overview = page.getByRole("dialog", { name: "Switch sessions" });
    let helperRow = overview.locator(
      `.workspace-session-row[data-workspace-session-name="${helperSession}"]`,
    );
    await expect(helperRow.getByRole("button", {
      name: `Move ${helperSession} tab to new window`,
    })).toBeVisible();
    await expect(helperRow.getByRole("button", {
      name: `Copy ${helperSession} tab to new window`,
    })).toBeVisible();
    await overview.getByRole("button", { name: "Close session switcher" }).click();
    await expectRoute(
      page,
      `/mux/session/${helperSession}`,
      sourceTabs,
      { kind: "shells", view: "list" },
    );

    await page.setViewportSize({ width: 390, height: 664 });
    await page.getByRole("navigation", { name: "Mobile console focus" })
      .getByRole("button", { name: "Overview" })
      .click();
    overview = page.getByRole("dialog", { name: "Switch sessions" });
    helperRow = overview.locator(
      `.workspace-session-row[data-workspace-session-name="${helperSession}"]`,
    );
    const mobileMove = helperRow.getByRole("button", {
      name: `Move ${helperSession} tab to new window`,
    });
    const mobileCopy = helperRow.getByRole("button", {
      name: `Copy ${helperSession} tab to new window`,
    });
    for (const action of [mobileMove, mobileCopy]) {
      const box = await action.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.width).toBeGreaterThanOrEqual(44 - CSS_PIXEL_TOLERANCE);
      expect(box!.height).toBeGreaterThanOrEqual(44 - CSS_PIXEL_TOLERANCE);
    }
    expect(await overview.evaluate((element) => element.scrollWidth <= element.clientWidth))
      .toBe(true);
    expect(await helperRow.locator(".workspace-session-actions").evaluate((element) => (
      element.scrollWidth <= element.clientWidth
    ))).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
      .toBe(true);
    await overview.getByRole("button", { name: "Close session switcher" }).click();
    await expectRoute(
      page,
      `/mux/session/${helperSession}`,
      sourceTabs,
      { kind: "shells", view: "list" },
    );

    await page.setViewportSize({ width: 1440, height: 900 });
    const orientationToggle = page.getByRole("group", { name: "Console bars" })
      .getByRole("button", { name: "Vertical session tabs" });
    await expect(orientationToggle).toHaveAttribute("aria-pressed", "true");
    await orientationToggle.click();
    await expect(navigation).toHaveAttribute("data-orientation", "horizontal");

    const [openedMove] = await Promise.all([
      page.context().waitForEvent("page"),
      page.getByRole("button", {
        name: `Move ${helperSession} tab to new window`,
      }).click(),
    ]);
    movedPage = openedMove;
    await expectRoute(
      movedPage,
      `/mux/session/${helperSession}`,
      [helperSession],
      { kind: "shells", view: "list" },
    );
    expect(await movedPage.evaluate(() => window.opener === null)).toBe(true);
    expect(new URL(movedPage.url()).searchParams.has("tab-group")).toBe(false);
    await expectRoute(
      page,
      `/mux/session/${sessionName}`,
      [sessionName],
      { kind: "shells", view: "list" },
    );
    await expect(navigation.locator(
      `.workspace-tab[data-workspace-session-name="${sessionName}"]`,
    )).toBeVisible();
    await expect(navigation.locator(
      `.workspace-tab[data-workspace-session-name="${helperSession}"]`,
    )).toHaveCount(0);
    expect(workspaceTmuxIdentity(sessionName)).toBe(primaryIdentity);
    expect(workspaceTmuxIdentity(helperSession)).toBe(helperIdentity);
  } finally {
    if (copiedPage && !copiedPage.isClosed()) await copiedPage.close();
    if (movedPage && !movedPage.isClosed()) await movedPage.close();
    try {
      execFileSync("tmux", [...tmux, "kill-session", "-t", `=${helperSession}`], {
        stdio: "ignore",
      });
    } catch {
      // Cleanup stays scoped to the session created on this test's disposable socket.
    }
  }
});

test("workspace tab groups persist in the URL and remain manageable on mobile", async ({ page }) => {
  test.setTimeout(60_000);
  const firstGroupedSession = `${sessionName}-group-one`;
  const secondGroupedSession = `${sessionName}-group-two`;
  const initialTabs = [sessionName, firstGroupedSession, secondGroupedSession];

  for (const helperSession of [firstGroupedSession, secondGroupedSession]) {
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
  }

  try {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(
      `/mux/session/${firstGroupedSession}?kind=shells`
      + initialTabs.map((tab) => `&tab=${encodeURIComponent(tab)}`).join(""),
    );
    await expect(page.locator(".connection-badge")).toContainText("Live", {
      timeout: 10_000,
    });

    await page.getByRole("button", { name: "Create tab group" }).click();
    const createDialog = page.getByRole("dialog", { name: "Create a group" });
    await createDialog.getByRole("textbox", { name: "Group name" }).fill("Review lane");
    await createDialog.getByRole("radio", { name: "orange" }).check();
    await createDialog.getByRole("checkbox", {
      name: new RegExp(secondGroupedSession),
    }).check();
    await createDialog.getByRole("button", { name: "Create group" }).click();

    const groupBlock = page.locator("[data-workspace-tab-group-id]").filter({
      has: page.getByRole("button", { name: "Collapse Review lane tab group" }),
    });
    await expect(groupBlock).toHaveAttribute("data-tab-group-color", "orange");
    await expect(groupBlock.getByRole("tab")).toHaveCount(2);
    await expect.poll(async () => page.evaluate(() => {
      const url = new URL(window.location.href);
      return {
        tabs: url.searchParams.getAll("tab"),
        groups: url.searchParams.getAll("tab-group").map((value) => JSON.parse(value)),
      };
    })).toEqual({
      tabs: initialTabs,
      groups: [{
        id: expect.any(String),
        name: "Review lane",
        color: "orange",
        collapsed: false,
        tabs: [firstGroupedSession, secondGroupedSession],
      }],
    });

    await page.getByRole("button", { name: "Search open tabs" }).click();
    const searchDialog = page.getByRole("dialog", { name: "Jump to tab" });
    await searchDialog.getByRole("combobox").fill("Review lane");
    await expect(searchDialog.getByRole("option")).toHaveCount(2);
    await searchDialog.getByRole("combobox").press("Escape");

    await page.getByRole("button", { name: "Collapse Review lane tab group" }).click();
    await expect(page.getByRole("tab", {
      name: new RegExp(`^${firstGroupedSession}, Review lane group`),
    })).toBeVisible();
    await expect(page.getByRole("tab", {
      name: new RegExp(`^${secondGroupedSession}, Review lane group`),
    })).toBeHidden();
    await page.getByRole("button", { name: "Expand Review lane tab group" }).click();

    await page.getByRole("button", { name: "Move Review lane group left" }).click();
    await expect.poll(async () => page.evaluate(() => (
      new URL(window.location.href).searchParams.getAll("tab")
    ))).toEqual([firstGroupedSession, secondGroupedSession, sessionName]);

    await page.setViewportSize({ width: 390, height: 664 });
    await page.getByRole("navigation", { name: "Mobile console focus" })
      .getByRole("button", { name: "Overview" })
      .click();
    const overview = page.getByRole("dialog", { name: "Switch sessions" });
    await overview.getByRole("button", { name: "Edit Review lane tab group" }).click();

    const editDialog = page.getByRole("dialog", { name: "Edit Review lane" });
    await editDialog.getByRole("textbox", { name: "Group name" }).fill("Release lane");
    await editDialog.getByRole("button", { name: "Save group" }).click();
    await expect(page.getByRole("dialog", { name: "Switch sessions" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Edit Release lane tab group" }))
      .toBeVisible();
    await page.screenshot({ path: "artifacts/workspace-tab-groups-mobile.png" });

    await page.getByRole("button", { name: "Close session switcher" }).click();
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.getByRole("button", { name: "Collapse Release lane tab group" }))
      .toBeVisible();
    await expect.poll(async () => page.evaluate(() => {
      const value = new URL(window.location.href).searchParams.get("tab-group");
      return value ? JSON.parse(value).name : null;
    })).toBe("Release lane");
    await page.screenshot({ path: "artifacts/workspace-tab-groups-desktop.png" });

    await page.getByRole("button", { name: "All sessions" }).click();
    await expect(page.locator("main.dashboard-shell")).toBeVisible();
    await expect(page.getByText("Release lane", { exact: true })).toHaveCount(0);
    await page.keyboard.press("Control+Shift+;");
    await expect(page.getByRole("dialog", { name: "Jump to tab" })).toHaveCount(0);
    await expect.poll(async () => page.evaluate(() => {
      const value = new URL(window.location.href).searchParams.get("tab-group");
      return value ? JSON.parse(value).name : null;
    })).toBe("Release lane");
  } finally {
    for (const helperSession of [firstGroupedSession, secondGroupedSession]) {
      try {
        execFileSync("tmux", [...tmux, "kill-session", "-t", `=${helperSession}`], {
          stdio: "ignore",
        });
      } catch {
        // Cleanup stays scoped to sessions created on this test's disposable socket.
      }
    }
  }
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

    await page.setViewportSize({ width: 390, height: 664 });
    const dashboardUrl = "/mux/?kind=shells&view=list";
    const dashboardQuery = { kind: "shells", view: "list" };
    await page.goto(dashboardUrl);
    await expect(page.getByRole("button", { name: `Open ${sessionName}`, exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: `Open ${alternateSessionName}`, exact: true })).toBeVisible();

    await page.getByRole("button", { name: `Open ${sessionName}`, exact: true }).click();
    await expect(page.locator(".connection-badge")).toContainText("Live", { timeout: 10_000 });
    await expect(page.getByRole("tab", { name: primaryTabName, includeHidden: true })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await expectRoute(
      page,
      `/mux/session/${sessionName}`,
      [sessionName],
      dashboardQuery,
    );

    const mobileFocus = page.getByRole("navigation", { name: "Mobile console focus" });
    const overviewMode = mobileFocus.getByRole("button", { name: "Overview" });
    const terminalMode = mobileFocus.getByRole("button", { name: "Terminal" });
    const inputMode = mobileFocus.getByRole("button", { name: "Input" });
    const consoleShell = page.locator(".console-shell");
    const consoleBars = page.getByRole("group", { name: "Console bars" });
    const sessionTabs = page.locator("#muxdeck-session-tabs");
    const stagedInputRegion = page.locator("#muxdeck-staged-input");
    const terminalShortcuts = page.locator("#muxdeck-terminal-shortcuts");

    await expect(mobileFocus).toBeVisible();
    await expect(consoleBars).toBeHidden();
    await expect(consoleShell).toHaveAttribute("data-mobile-focus", "terminal");
    await expect(terminalMode).toHaveAttribute("aria-pressed", "true");
    await expect(overviewMode).toHaveAttribute("aria-pressed", "false");
    await expect(inputMode).toHaveAttribute("aria-pressed", "false");
    await expect(sessionTabs).toBeHidden();
    await expect(stagedInputRegion).toBeHidden();
    await expect(terminalShortcuts).toBeHidden();
    for (const mode of [overviewMode, terminalMode, inputMode]) {
      const box = await mode.boundingBox();
      expect(box?.width).toBeGreaterThanOrEqual(44);
      expect(box?.height).toBeGreaterThanOrEqual(44);
    }
    const terminalHeight = await page.locator(".terminal-stage").evaluate(
      (element) => element.getBoundingClientRect().height,
    );
    expect(terminalHeight).toBeGreaterThan(480);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
      .toBe(true);
    await page.screenshot({ path: "artifacts/console-mobile-terminal.png" });

    await overviewMode.click();
    await expectRoute(
      page,
      `/mux/session/${sessionName}/recents`,
      [sessionName],
      dashboardQuery,
    );
    const switcher = page.getByRole("dialog", { name: "Switch sessions" });
    await expect(switcher).toBeVisible();
    await expect(switcher).toBeFocused();
    await expect(overviewMode).toHaveAttribute("aria-pressed", "true");
    await expect(switcher.getByText("Active \u00b7 Other")).toBeVisible();
    const switcherBox = await switcher.boundingBox();
    expect(switcherBox?.width).toBeLessThanOrEqual(390);
    expect(switcherBox?.height).toBeLessThanOrEqual(664);
    const focusBox = await mobileFocus.boundingBox();
    expect(switcherBox!.y).toBeGreaterThanOrEqual(focusBox!.y + focusBox!.height - 1);

    await switcher.locator(".workspace-session-select")
      .filter({ hasText: alternateSessionName })
      .click();
    await expectRoute(
      page,
      `/mux/session/${alternateSessionName}`,
      [sessionName, alternateSessionName],
      dashboardQuery,
    );
    await expect(page.locator(".connection-badge")).toContainText("Live", { timeout: 10_000 });
    await expect(consoleShell).toHaveAttribute("data-mobile-focus", "terminal");
    await expect(page.locator("[role='tab']")).toHaveCount(2);
    await expect(page.getByRole("tab", { name: alternateTabName, includeHidden: true })).toHaveAttribute(
      "aria-selected",
      "true",
    );

    const orderedTabSearch = `?kind=shells&view=list&tab=${encodeURIComponent(sessionName)}&tab=${encodeURIComponent(alternateSessionName)}`;
    const alternateUrl = `/mux/session/${alternateSessionName}${orderedTabSearch}`;
    const primaryUrl = `/mux/session/${sessionName}${orderedTabSearch}`;
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.locator("[role='tab']")).toHaveCount(2);
    await expect(page.getByRole("tab", { name: primaryTabName, includeHidden: true }))
      .toHaveAttribute("aria-label", primaryTabName);
    await expect(page.getByRole("tab", { name: alternateTabName, includeHidden: true })).toHaveAttribute(
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
    await expect(consoleShell).toHaveAttribute("data-mobile-focus", "terminal");

    const constructedTerminalSocketCount = () => page.evaluate(() => {
      const sockets = (window as Window & { __muxdeckTestSockets: WebSocket[] })
        .__muxdeckTestSockets;
      return sockets.filter((socket) => socket.url.includes("/ws/terminal")).length;
    });
    const socketsBeforeModes = await constructedTerminalSocketCount();
    const visibilityDraft = "mobile focus modes keep this staged draft";
    const alternateDraft = page.locator("#terminal-staged-input");
    await inputMode.click();
    await expect(consoleShell).toHaveAttribute("data-mobile-focus", "input");
    await expect(inputMode).toHaveAttribute("aria-pressed", "true");
    await expect(stagedInputRegion).toBeVisible();
    await expect(terminalShortcuts).toBeVisible();
    await expect(alternateDraft).toBeFocused();
    await alternateDraft.fill(visibilityDraft);
    await alternateDraft.evaluate((textarea) => {
      const field = textarea as HTMLTextAreaElement;
      field.setSelectionRange(6, 6);
    });
    const sendWithTab = page.getByRole("button", {
      name: "Send + Tab",
    });
    await expect(sendWithTab).toBeEnabled();
    await expect(alternateDraft).toHaveValue(visibilityDraft);
    await expect(alternateDraft).toBeFocused();
    const stagedActionButtons = page.locator(".composer-actions-primary > button");
    await expect(stagedActionButtons).toHaveCount(5);
    const compactActionLabels = page.locator(
      ".composer-actions-primary .composer-action-label-compact",
    );
    expect(await compactActionLabels.allTextContents()).toEqual(["C", "S", "S+E", "M", "S+T"]);
    for (const label of await compactActionLabels.all()) await expect(label).toBeVisible();
    for (const label of await page.locator(
      ".composer-actions-primary .composer-action-label-full",
    ).all()) {
      await expect(label).toBeHidden();
    }

    const terminalElementBeforeInputFocus = page.locator(".terminal-host .xterm");
    await terminalElementBeforeInputFocus.evaluate((element) => {
      Object.defineProperty(window, "__muxdeckInputFocusTerminal", { value: element });
    });
    const inputFocusUrl = page.url();
    const inputFocusHistoryLength = await page.evaluate(() => window.history.length);
    const inputFocusTmuxSize = workspaceTmuxSnapshot(alternateSessionName);
    const enterInputFocus = page.getByRole("button", {
      name: "Enter distraction-free input",
    });
    await expect(enterInputFocus).toHaveAttribute("aria-pressed", "false");
    await enterInputFocus.click();

    await expect(consoleShell).toHaveAttribute("data-mobile-distraction-free", "true");
    await expect(mobileFocus).toBeHidden();
    await expect(page.locator(".terminal-view")).toBeHidden();
    await expect(terminalShortcuts).toBeHidden();
    await expect(stagedInputRegion).toBeVisible();
    await expect(alternateDraft).toBeVisible();
    await expect(alternateDraft).toBeFocused();
    await expect(alternateDraft).toHaveValue(visibilityDraft);
    await expect(page.locator(".composer-heading > label"))
      .toHaveCSS("clip", "rect(0px, 0px, 0px, 0px)");
    const focusedComposerStatus = page.locator(".composer-status");
    await expect(focusedComposerStatus).toBeVisible();
    await expect(focusedComposerStatus).toBeInViewport();
    expect((await alternateDraft.boundingBox())!.height).toBeGreaterThan(144);
    const exitInputFocus = page.getByRole("button", {
      name: "Exit distraction-free input",
    });
    await expect(exitInputFocus).toHaveAttribute("aria-pressed", "true");
    const focusedInputControls = [
      page.getByRole("button", { name: "Clear" }),
      page.getByRole("button", { name: "Send", exact: true }),
      page.getByRole("button", { name: "Send + Enter" }),
      page.getByRole("button", { name: "Queue in memo" }),
      sendWithTab,
      exitInputFocus,
    ];
    for (const control of focusedInputControls) {
      await expect(control).toBeVisible();
      await expect(control).toHaveCSS("min-height", "44px");
    }
    expect(await page.locator(".input-dock button:visible").count()).toBe(6);
    expect(await terminalElementBeforeInputFocus.evaluate((element) => (
      element === (window as Window & { __muxdeckInputFocusTerminal: Element })
        .__muxdeckInputFocusTerminal
    ))).toBe(true);
    expect(await constructedTerminalSocketCount()).toBe(socketsBeforeModes);
    expect(workspaceTmuxSnapshot(alternateSessionName)).toBe(inputFocusTmuxSize);
    expect(page.url()).toBe(inputFocusUrl);
    expect(await page.evaluate(() => window.history.length)).toBe(inputFocusHistoryLength);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
      .toBe(true);
    await page.screenshot({ path: "artifacts/console-mobile-input-distraction-free.png" });

    await page.setViewportSize({ width: 932, height: 430 });
    for (const control of focusedInputControls) {
      const box = await control.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.width).toBeGreaterThanOrEqual(44);
      expect(box!.height).toBeGreaterThanOrEqual(44);
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(932);
    }
    expect(await page.locator(".composer-actions-primary").evaluate((element) => (
      element.scrollWidth <= element.clientWidth
    ))).toBe(true);

    await page.setViewportSize({ width: 844, height: 120 });
    const focusedInputDock = page.locator(".input-dock");
    await expect.poll(() => consoleShell.evaluate((element) => {
      const viewport = window.visualViewport;
      const viewportTop = viewport?.offsetTop ?? 0;
      const viewportBottom = viewportTop + (viewport?.height ?? window.innerHeight);
      const bounds = element.getBoundingClientRect();
      return bounds.top >= viewportTop - 1 && bounds.bottom <= viewportBottom + 1;
    })).toBe(true);
    await expect(focusedInputDock).toHaveCSS("overflow-y", "auto");
    for (const element of [...focusedInputControls, focusedComposerStatus]) {
      await element.scrollIntoViewIfNeeded();
      await expect(element).toBeInViewport();
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
      .toBe(true);

    await page.setViewportSize({ width: 390, height: 664 });

    await exitInputFocus.click();
    await expect(consoleShell).toHaveAttribute("data-mobile-distraction-free", "false");
    await expect(mobileFocus).toBeVisible();
    await expect(page.locator(".terminal-view")).toBeVisible();
    await expect(terminalShortcuts).toBeVisible();
    await expect(alternateDraft).toHaveValue(visibilityDraft);
    await expect.poll(() => workspaceTmuxSnapshot(alternateSessionName))
      .toBe(inputFocusTmuxSize);
    expect(await constructedTerminalSocketCount()).toBe(socketsBeforeModes);
    await page.screenshot({ path: "artifacts/console-mobile-input.png" });
    const inputTerminalHeight = await page.locator(".terminal-stage").evaluate(
      (element) => element.getBoundingClientRect().height,
    );
    expect(inputTerminalHeight).toBeLessThan(terminalHeight);
    const inputDockBox = await page.locator(".input-dock").boundingBox();
    expect(inputDockBox!.y + inputDockBox!.height).toBeLessThanOrEqual(664);
    await expect(page).toHaveURL(alternateUrl);
    await terminalMode.click();
    await expect(consoleShell).toHaveAttribute("data-mobile-focus", "terminal");
    await expect(stagedInputRegion).toBeHidden();
    await expect(terminalShortcuts).toBeHidden();
    await expect(alternateDraft).not.toBeFocused();
    await expect(alternateDraft).toHaveValue(visibilityDraft);
    await expect(page).toHaveURL(alternateUrl);
    await expect.poll(async () => {
      const sockets = await activeTerminalSockets();
      return sockets.length === 1 && sockets[0].includes(`session=${alternateSessionName}`);
    }).toBe(true);
    const restoredTerminalHeight = await page.locator(".terminal-stage").evaluate(
      (element) => element.getBoundingClientRect().height,
    );
    expect(restoredTerminalHeight).toBeGreaterThan(inputTerminalHeight);
    expect(await constructedTerminalSocketCount()).toBe(socketsBeforeModes);

    await inputMode.click();
    await expect(alternateDraft).toHaveValue(visibilityDraft);
    await page.goBack();
    await expectRoute(page, "/mux/", [sessionName, alternateSessionName], dashboardQuery);
    const resumeWorkspace = page.getByRole("button", {
      name: `Resume workspace at ${alternateSessionName}, 2 open tabs`,
    });
    await expect(resumeWorkspace).toBeVisible();
    const resumeBox = await resumeWorkspace.boundingBox();
    expect(resumeBox?.height).toBeGreaterThanOrEqual(48);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
      .toBe(true);
    await page.screenshot({ path: "artifacts/resume-workspace-mobile.png", fullPage: true });
    await resumeWorkspace.click();
    await expect(page).toHaveURL(alternateUrl);
    await expect(consoleShell).toHaveAttribute("data-mobile-focus", "input");
    await expect(inputMode).toHaveAttribute("aria-pressed", "true");
    await expect(alternateDraft).toHaveValue(visibilityDraft);
    await expect.poll(async () => {
      const sockets = await activeTerminalSockets();
      return sockets.length === 1 && sockets[0].includes(`session=${alternateSessionName}`);
    }).toBe(true);

    await page.setViewportSize({ width: 320, height: 568 });
    await expect(stagedInputRegion).toBeVisible();
    await expect(page.getByRole("button", { name: "Send + Enter" })).toBeInViewport();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
      .toBe(true);
    const compactInputHeight = await page.locator(".terminal-stage").evaluate(
      (element) => element.getBoundingClientRect().height,
    );
    expect(compactInputHeight).toBeGreaterThanOrEqual(64);

    await page.setViewportSize({ width: 390, height: 360 });
    await expect.poll(() => consoleShell.evaluate((element) => {
      const viewport = window.visualViewport;
      const viewportBottom = (viewport?.offsetTop ?? 0) + (viewport?.height ?? window.innerHeight);
      return element.getBoundingClientRect().bottom <= viewportBottom + 1;
    })).toBe(true);
    const visibleInputBounds = await page.evaluate(() => {
      const viewport = window.visualViewport;
      const textarea = document.querySelector<HTMLTextAreaElement>("#terminal-staged-input")!;
      const send = document.querySelector<HTMLElement>(".composer-send-enter")!;
      const mode = document.querySelector<HTMLElement>(".mobile-console-focus")!;
      const viewportTop = viewport?.offsetTop ?? 0;
      const viewportBottom = viewportTop + (viewport?.height ?? window.innerHeight);
      return {
        viewportTop,
        viewportBottom,
        textarea: textarea.getBoundingClientRect(),
        send: send.getBoundingClientRect(),
        mode: mode.getBoundingClientRect(),
      };
    });
    expect(visibleInputBounds.mode.top).toBeGreaterThanOrEqual(visibleInputBounds.viewportTop - 1);
    expect(visibleInputBounds.textarea.bottom).toBeLessThanOrEqual(
      visibleInputBounds.viewportBottom + 1,
    );
    expect(visibleInputBounds.send.bottom).toBeLessThanOrEqual(
      visibleInputBounds.viewportBottom + 1,
    );

    await terminalMode.click();
    await page.setViewportSize({ width: 750, height: 342 });
    await expect(mobileFocus).toBeVisible();
    await expect(consoleShell).toHaveAttribute("data-mobile-focus", "terminal");
    const landscapeTerminalHeight = await page.locator(".terminal-stage").evaluate(
      (element) => element.getBoundingClientRect().height,
    );
    expect(landscapeTerminalHeight).toBeGreaterThan(150);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
      .toBe(true);

    await page.setViewportSize({ width: 390, height: 664 });
    await overviewMode.click();
    const currentOverview = page.getByRole("dialog", { name: "Switch sessions" });
    await expect(currentOverview).toBeVisible();
    await expect.poll(() => currentOverview.evaluate((element) => (
      getComputedStyle(element).opacity
    ))).toBe("1");
    await page.screenshot({ path: "artifacts/workspace-overview-mobile.png" });
    await currentOverview.getByRole("button", { name: new RegExp(`^${sessionName} `) }).click();
    await expect(page).toHaveURL(primaryUrl);
    await expect(consoleShell).toHaveAttribute("data-mobile-focus", "terminal");
    await expect.poll(async () => {
      const sockets = await activeTerminalSockets();
      return sockets.length === 1 && sockets[0].includes(`session=${sessionName}&`);
    }).toBe(true);

    await overviewMode.click();
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

    await overviewMode.click();
    const recentOverview = page.getByRole("dialog", { name: "Switch sessions" });
    await expect(recentOverview.getByRole("heading", { name: "Recently visited" })).toBeVisible();
    await expect(recentOverview).toContainText(sessionName);
    const workspaceSearch = recentOverview.getByRole("searchbox", {
      name: "Find a workspace session",
    });
    await workspaceSearch.fill(sessionName);
    const clearWorkspaceSearch = recentOverview.getByRole("button", {
      name: "Clear workspace search",
    });
    await clearWorkspaceSearch.focus();
    await clearWorkspaceSearch.press("Enter");
    await page.keyboard.press("Tab");
    expect(await recentOverview.evaluate((dialog) => dialog.contains(document.activeElement)))
      .toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
      .toBe(true);
    await page.getByRole("button", { name: "Close session switcher" }).click();
    await expect(page).toHaveURL(alternateOnlyUrl);

    await inputMode.click();
    await expect(alternateDraft).toHaveValue(visibilityDraft);
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(consoleShell).toHaveAttribute("data-mobile-focus", "terminal");
    await expect(terminalMode).toHaveAttribute("aria-pressed", "true");
    await expect(stagedInputRegion).toBeHidden();
    await expect(terminalShortcuts).toBeHidden();
    await expect(alternateDraft).toHaveValue(visibilityDraft);
    await expect(page.locator("[role='tab']")).toHaveCount(1);
    await expect(page.getByRole("tab", { name: alternateTabName, includeHidden: true })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await page.getByRole("button", { name: "Back to sessions" }).click();
    await expectRoute(page, "/mux/", [alternateSessionName], dashboardQuery);
  } finally {
    try {
      execFileSync("tmux", [...tmux, "kill-session", "-t", `=${alternateSessionName}`]);
    } catch {
      // The isolated session may already have ended after a failed assertion.
    }
  }
});

test("saved workspace survives reload and device handoff without touching tmux panes", async ({
  page,
  browser,
  request,
}) => {
  test.setTimeout(60_000);
  const sharedSession = `${sessionName}-saved-workspace`;
  const workspaceName = `Device handoff ${process.pid}`;
  const renamedWorkspaceName = `${workspaceName} renamed`;
  const orderedTabs = [sessionName, sharedSession];
  let secondContext: Awaited<ReturnType<typeof browser.newContext>> | null = null;
  let cleanupWorkspaceId: string | null = null;

  execFileSync("tmux", [
    ...tmux,
    "new-session",
    "-d",
    "-s",
    sharedSession,
    "bash",
    "--noprofile",
    "--norc",
  ]);
  const originalTmuxIdentities = orderedTabs.map(workspaceTmuxIdentity);

  try {
    await page.goto("/mux/?kind=shells&view=list");
    await page.getByRole("button", { name: `Open ${sessionName}`, exact: true }).click();
    await expect(page.locator(".connection-badge")).toContainText("Live", { timeout: 10_000 });
    await page.getByRole("button", { name: /Open session switcher/ }).click();
    await page.getByRole("dialog", { name: "Switch sessions" })
      .locator(".workspace-session-select")
      .filter({ hasText: sharedSession })
      .click();
    await expectRoute(
      page,
      `/mux/session/${sharedSession}`,
      orderedTabs,
      { kind: "shells", view: "list" },
    );
    await expect(page.locator(".connection-badge")).toContainText("Live", { timeout: 10_000 });

    const beforeSaveTmuxSnapshots = orderedTabs.map(workspaceTmuxSnapshot);
    const saveWorkspace = page.getByRole("button", {
      name: "Save workspace",
      exact: true,
    });
    await expect(saveWorkspace).toBeVisible();
    await saveWorkspace.click();
    const saveDialog = page.getByRole("dialog", { name: "Save this workspace" });
    await expect(saveDialog).toBeVisible();
    await expect(saveDialog).toContainText("Save 2 open tabs in their current order.");
    const workspaceNameInput = saveDialog.getByRole("textbox", { name: "Workspace name" });
    await expect(workspaceNameInput).toBeFocused();
    await workspaceNameInput.fill(workspaceName);
    await saveDialog.getByRole("button", { name: "Save workspace", exact: true }).click();

    await expect.poll(() => new URL(page.url()).searchParams.get("workspace")).toMatch(/.+/);
    const workspaceId = new URL(page.url()).searchParams.get("workspace");
    if (!workspaceId) throw new Error("Created workspace URL is missing its workspace id");
    cleanupWorkspaceId = workspaceId;
    await expectRoute(
      page,
      `/mux/session/${sharedSession}`,
      orderedTabs,
      { kind: "shells", view: "list", workspace: workspaceId },
    );
    await expect(page.locator(".connection-badge")).toContainText("Live", { timeout: 10_000 });
    await expect(page.getByRole("status", { name: "Workspace saved automatically" }))
      .toBeVisible();
    await expect(page).toHaveTitle(`${workspaceName} - ${sharedSession}`);
    expect(orderedTabs.map(workspaceTmuxSnapshot)).toEqual(beforeSaveTmuxSnapshots);
    expect(orderedTabs.map(workspaceTmuxIdentity)).toEqual(originalTmuxIdentities);

    await expect.poll(async () => {
      const response = await request.get(`/mux/api/workspaces/${encodeURIComponent(workspaceId)}`);
      if (!response.ok()) return null;
      const body = await response.json();
      return {
        name: body.workspace.name,
        tabs: body.workspace.tabs,
        activeSession: body.workspace.activeSession,
        hasLastActiveTime: body.workspace.lastActiveAt > 0,
      };
    }).toEqual({
      name: workspaceName,
      tabs: orderedTabs,
      activeSession: sharedSession,
      hasLastActiveTime: true,
    });

    const reversedTabs = [...orderedTabs].reverse();
    const savedWorkspaceTabs = page.locator("#muxdeck-session-tabs [role='tab']");
    await page.getByRole("button", { name: `Move ${sharedSession} tab left` }).click();
    await expect(savedWorkspaceTabs).toHaveText(reversedTabs);
    await expectRoute(
      page,
      `/mux/session/${sharedSession}`,
      reversedTabs,
      { kind: "shells", view: "list", workspace: workspaceId },
    );
    await expect.poll(async () => {
      const response = await request.get(`/mux/api/workspaces/${encodeURIComponent(workspaceId)}`);
      if (!response.ok()) return null;
      const body = await response.json();
      return body.workspace.tabs;
    }).toEqual(reversedTabs);

    // Restore the fixture's original ordering after proving saved-workspace autosync.
    await page.getByRole("button", { name: `Move ${sharedSession} tab right` }).click();
    await expect(savedWorkspaceTabs).toHaveText(orderedTabs);
    await expectRoute(
      page,
      `/mux/session/${sharedSession}`,
      orderedTabs,
      { kind: "shells", view: "list", workspace: workspaceId },
    );
    await expect.poll(async () => {
      const response = await request.get(`/mux/api/workspaces/${encodeURIComponent(workspaceId)}`);
      if (!response.ok()) return null;
      const body = await response.json();
      return body.workspace.tabs;
    }).toEqual(orderedTabs);

    await page.setViewportSize({ width: 390, height: 664 });
    const mobileFocus = page.getByRole("navigation", { name: "Mobile console focus" });
    await mobileFocus.getByRole("button", { name: "Overview" }).click();
    await expectRoute(
      page,
      `/mux/session/${sharedSession}/recents`,
      orderedTabs,
      { kind: "shells", view: "list", workspace: workspaceId },
    );
    const mobileOverview = page.getByRole("dialog", { name: "Switch sessions" });
    await expect(mobileOverview.getByRole("status", {
      name: "Workspace saved automatically",
    })).toBeVisible();
    expect(await mobileOverview.locator(".workspace-recents-footer").evaluate((footer) => (
      footer.scrollWidth <= footer.clientWidth
    ))).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
      .toBe(true);
    await page.getByRole("button", { name: "Close session switcher" }).click();
    await expectRoute(
      page,
      `/mux/session/${sharedSession}`,
      orderedTabs,
      { kind: "shells", view: "list", workspace: workspaceId },
    );
    await page.setViewportSize({ width: 1280, height: 720 });

    await page.getByRole("button", { name: "Back to sessions" }).click();
    const firstDeviceCard = page.locator(".saved-workspace-card").filter({
      has: page.getByRole("heading", { name: workspaceName, exact: true }),
    });
    const firstActivity = firstDeviceCard.locator(".saved-workspace-activity");
    await expect(firstActivity).toHaveText(/^Active /);
    await expect(firstActivity).toHaveAttribute("title", /.+/);

    const origin = new URL(page.url()).origin;
    secondContext = await browser.newContext();
    const secondPage = await secondContext.newPage();
    await secondPage.goto(`${origin}/mux/`);
    await expect(secondPage.getByRole("heading", { name: workspaceName, exact: true })).toBeVisible();
    const beforeResumeResponse = await request.get(
      `/mux/api/workspaces/${encodeURIComponent(workspaceId)}`,
    );
    expect(beforeResumeResponse.ok()).toBe(true);
    const beforeResumeBody = await beforeResumeResponse.json();
    const activityResponsePromise = secondPage.waitForResponse((response) => (
      response.request().method() === "POST"
      && new URL(response.url()).pathname
        === `/mux/api/workspaces/${encodeURIComponent(workspaceId)}/activity`
      && response.ok()
    ));
    await secondPage.getByRole("button", {
      name: `Resume workspace ${workspaceName}`,
      exact: true,
    }).click();
    await expectRoute(
      secondPage,
      `/mux/session/${sharedSession}`,
      orderedTabs,
      { workspace: workspaceId },
    );
    await expect(secondPage.locator(".connection-badge")).toContainText("Live", {
      timeout: 10_000,
    });
    await expect(secondPage).toHaveTitle(`${workspaceName} - ${sharedSession}`);
    const activityResponse = await activityResponsePromise;
    const activityBody = await activityResponse.json();
    expect(activityBody.workspace.lastActiveAt)
      .toBeGreaterThan(beforeResumeBody.workspace.lastActiveAt);

    await secondPage.evaluate(([firstTab, secondTab]) => {
      const url = new URL(window.location.href);
      url.searchParams.delete("tab");
      url.searchParams.append("tab", secondTab);
      url.searchParams.append("tab", firstTab);
      window.history.replaceState(window.history.state, "", url);
    }, orderedTabs);
    expect(new URL(secondPage.url()).searchParams.getAll("tab"))
      .toEqual([...orderedTabs].reverse());
    const hydrationResponsePromise = secondPage.waitForResponse((response) => (
      response.request().method() === "GET"
      && new URL(response.url()).pathname
        === `/mux/api/workspaces/${encodeURIComponent(workspaceId)}`
      && response.ok()
    ));
    await secondPage.reload({ waitUntil: "domcontentloaded" });
    await hydrationResponsePromise;
    await expectRoute(
      secondPage,
      `/mux/session/${sharedSession}`,
      orderedTabs,
      { workspace: workspaceId },
    );
    await expect(secondPage.locator(".connection-badge")).toContainText("Live", {
      timeout: 10_000,
    });
    await expect(secondPage).toHaveTitle(`${workspaceName} - ${sharedSession}`);

    await secondPage.getByRole("button", { name: "Back to sessions" }).click();
    const secondDeviceCard = secondPage.locator(".saved-workspace-card").filter({
      has: secondPage.getByRole("heading", { name: workspaceName, exact: true }),
    });
    await secondDeviceCard.getByRole("button", {
      name: `Rename workspace ${workspaceName}`,
      exact: true,
    }).click();
    const renameForm = secondPage.locator(".saved-workspace-rename-form");
    await renameForm.getByRole("textbox", { name: "New workspace name" })
      .fill(renamedWorkspaceName);
    await renameForm.getByRole("button", { name: "Save", exact: true }).click();
    await expect(secondPage.getByRole("heading", {
      name: renamedWorkspaceName,
      exact: true,
    })).toBeVisible();

    await expect.poll(async () => {
      const response = await request.get(`/mux/api/workspaces/${encodeURIComponent(workspaceId)}`);
      if (!response.ok()) return null;
      const body = await response.json();
      return body.workspace.name;
    }).toBe(renamedWorkspaceName);

    await page.goto(`${origin}/mux/`);
    const renamedFirstDeviceCard = page.locator(".saved-workspace-card").filter({
      has: page.getByRole("heading", { name: renamedWorkspaceName, exact: true }),
    });
    await expect(renamedFirstDeviceCard).toBeVisible();
    const renamedActivity = renamedFirstDeviceCard.locator(".saved-workspace-activity");
    await expect(renamedActivity).toHaveText("Active just now");
    await expect(renamedActivity).toHaveAttribute("title", /.+/);

    const renamedSecondDeviceCard = secondPage.locator(".saved-workspace-card").filter({
      has: secondPage.getByRole("heading", { name: renamedWorkspaceName, exact: true }),
    });
    await renamedSecondDeviceCard.getByRole("button", {
      name: `Delete workspace ${renamedWorkspaceName}`,
      exact: true,
    }).click();
    const deleteDialog = renamedSecondDeviceCard.getByRole("alertdialog");
    await expect(deleteDialog).toContainText("Tmux sessions keep running.");
    const beforeDeleteTmuxSnapshots = orderedTabs.map(workspaceTmuxSnapshot);
    await deleteDialog.getByRole("button", { name: "Delete workspace", exact: true }).click();

    await expect.poll(async () => {
      const response = await request.get("/mux/api/workspaces");
      if (!response.ok()) return true;
      const body = await response.json();
      return body.workspaces.some((workspace: { id: string }) => workspace.id === workspaceId);
    }).toBe(false);
    cleanupWorkspaceId = null;
    await expect.poll(() => new URL(secondPage.url()).searchParams.get("workspace")).toBeNull();
    expect(orderedTabs.map(workspaceTmuxSnapshot)).toEqual(beforeDeleteTmuxSnapshots);
    expect(orderedTabs.map(workspaceTmuxIdentity)).toEqual(originalTmuxIdentities);
  } finally {
    await secondContext?.close();
    if (cleanupWorkspaceId) {
      try {
        await request.delete(`/mux/api/workspaces/${encodeURIComponent(cleanupWorkspaceId)}`);
      } catch {
        // A failed run must not leave workspace state behind for later tests.
      }
    }
    try {
      execFileSync("tmux", [...tmux, "kill-session", "-t", `=${sharedSession}`], {
        stdio: "ignore",
      });
    } catch {
      // Cleanup stays scoped to the helper session on this test's disposable socket.
    }
  }
});

test("desktop link shelf keeps common links global and workspace links isolated", async ({
  page,
  request,
}) => {
  const firstName = `Link shelf one ${process.pid}`;
  const secondName = `Link shelf two ${process.pid}`;
  const workspaceIds: string[] = [];

  const createWorkspace = async (name: string): Promise<string> => {
    const response = await request.post("/mux/api/workspaces", {
      data: {
        name,
        tabs: [sessionName],
        groups: [],
        activeSession: sessionName,
      },
    });
    expect(response.ok()).toBe(true);
    const body = await response.json();
    return body.workspace.id as string;
  };

  try {
    const resetCommon = await request.put("/mux/api/workspace-quick-links", {
      data: { links: [] },
    });
    expect(resetCommon.ok()).toBe(true);
    workspaceIds.push(await createWorkspace(firstName));
    workspaceIds.push(await createWorkspace(secondName));

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(
      `/mux/session/${encodeURIComponent(sessionName)}`
      + `?workspace=${encodeURIComponent(workspaceIds[0])}`
      + `&tab=${encodeURIComponent(sessionName)}`,
    );
    await expect(page.getByRole("status", { name: "Workspace saved automatically" }))
      .toBeVisible();

    const commonRegion = page.getByRole("region", { name: "Common quick links" });
    const workspaceRegion = page.getByRole("region", { name: "Workspace quick links" });
    const consoleToolbar = page.getByRole("group", { name: "Console bars" });
    const tabsToggle = consoleToolbar.getByRole("button", {
      name: "Session tabs",
      exact: true,
    });
    await expect(commonRegion).toBeVisible();
    await expect(workspaceRegion).toContainText(firstName);
    await expect(consoleToolbar.getByRole("region", { name: "Common quick links" }))
      .toBeVisible();
    await expect(consoleToolbar.getByRole("region", { name: "Workspace quick links" }))
      .toBeVisible();
    const commonBox = await commonRegion.boundingBox();
    const workspaceBox = await workspaceRegion.boundingBox();
    const tabsBox = await tabsToggle.boundingBox();
    expect(commonBox).not.toBeNull();
    expect(workspaceBox).not.toBeNull();
    expect(tabsBox).not.toBeNull();
    expect(commonBox!.x).toBeLessThan(workspaceBox!.x);
    expect(Math.abs(commonBox!.y - workspaceBox!.y)).toBeLessThan(1);
    expect(Math.abs(
      commonBox!.y + commonBox!.height / 2
      - (tabsBox!.y + tabsBox!.height / 2),
    )).toBeLessThan(1);

    await page.setViewportSize({ width: 800, height: 700 });
    const narrowToolbarBox = await consoleToolbar.boundingBox();
    const narrowWorkspaceBox = await workspaceRegion.boundingBox();
    const narrowFocusBox = await consoleToolbar.getByRole("button", {
      name: "Enter desktop terminal focus",
    }).boundingBox();
    expect(narrowToolbarBox).not.toBeNull();
    expect(narrowWorkspaceBox).not.toBeNull();
    expect(narrowFocusBox).not.toBeNull();
    expect(narrowWorkspaceBox!.x + narrowWorkspaceBox!.width)
      .toBeLessThanOrEqual(narrowToolbarBox!.x + narrowToolbarBox!.width + 1);
    expect(narrowFocusBox!.x + narrowFocusBox!.width)
      .toBeLessThanOrEqual(narrowToolbarBox!.x + narrowToolbarBox!.width + 1);
    await page.setViewportSize({ width: 1440, height: 900 });

    await tabsToggle.click();
    await expect(tabsToggle).toHaveAttribute("aria-pressed", "false");
    await expect(page.locator('nav[aria-label="Session workspace"]'))
      .not.toBeVisible();
    await expect(commonRegion).toBeVisible();
    await expect(workspaceRegion).toBeVisible();
    await tabsToggle.click();
    await expect(tabsToggle).toHaveAttribute("aria-pressed", "true");

    await commonRegion.getByRole("button", {
      name: "Manage common quick links",
    }).click();
    const commonDialog = page.getByRole("dialog", { name: "Manage Common links" });
    await commonDialog.getByRole("textbox", { name: "Label" }).fill("Team runbook");
    await commonDialog.getByRole("textbox", { name: "URL" })
      .fill("docs.example.test/runbook");
    await commonDialog.getByRole("button", { name: "Add to shelf" }).click();
    await commonDialog.getByRole("button", { name: "Save links" }).click();
    const commonLink = commonRegion.getByRole("link", { name: "Team runbook" });
    await expect(commonLink).toHaveAttribute("href", "https://docs.example.test/runbook");
    await expect(commonLink).toHaveAttribute("target", "_blank");
    await expect(commonLink).toHaveAttribute("rel", "noreferrer");

    await workspaceRegion.getByRole("button", {
      name: "Manage workspace quick links",
    }).click();
    const workspaceDialog = page.getByRole("dialog", {
      name: `Manage ${firstName} links`,
    });
    await workspaceDialog.getByRole("textbox", { name: "Label" }).fill("Launch ticket");
    await workspaceDialog.getByRole("textbox", { name: "URL" })
      .fill("https://issues.example.test/launch");
    await workspaceDialog.getByRole("button", { name: "Add to shelf" }).click();
    await workspaceDialog.getByRole("button", { name: "Save links" }).click();
    await expect(workspaceRegion.getByRole("link", { name: "Launch ticket" })).toBeVisible();

    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.getByRole("region", { name: "Common quick links" })
      .getByRole("link", { name: "Team runbook" })).toBeVisible();
    await expect(page.getByRole("region", { name: "Workspace quick links" })
      .getByRole("link", { name: "Launch ticket" })).toBeVisible();

    await page.getByRole("button", { name: "Vertical session tabs" }).click();
    const verticalCommonBox = await commonRegion.boundingBox();
    const verticalWorkspaceBox = await workspaceRegion.boundingBox();
    expect(verticalCommonBox).not.toBeNull();
    expect(verticalWorkspaceBox).not.toBeNull();
    expect(verticalCommonBox!.x).toBeLessThan(verticalWorkspaceBox!.x);
    expect(Math.abs(verticalCommonBox!.y - verticalWorkspaceBox!.y)).toBeLessThan(1);

    await page.goto(
      `/mux/session/${encodeURIComponent(sessionName)}`
      + `?workspace=${encodeURIComponent(workspaceIds[1])}`
      + `&tab=${encodeURIComponent(sessionName)}`,
    );
    const secondCommonRegion = page.getByRole("region", { name: "Common quick links" });
    const secondWorkspaceRegion = page.getByRole("region", { name: "Workspace quick links" });
    await expect(secondCommonRegion.getByRole("link", { name: "Team runbook" })).toBeVisible();
    await expect(secondWorkspaceRegion).toContainText(secondName);
    await expect(secondWorkspaceRegion).toContainText("No links yet");
    await expect(secondWorkspaceRegion.getByRole("link", { name: "Launch ticket" }))
      .toHaveCount(0);

    await page.goto(
      `/mux/session/${encodeURIComponent(sessionName)}`
      + `?tab=${encodeURIComponent(sessionName)}`,
    );
    await expect(page.getByRole("region", { name: "Common quick links" })
      .getByRole("link", { name: "Team runbook" })).toBeVisible();
    const temporaryRegion = page.getByRole("region", { name: "Workspace quick links" });
    await expect(temporaryRegion).toContainText("Save workspace to add links");
    await expect(temporaryRegion.getByRole("button", {
      name: "Manage workspace quick links",
    })).toBeDisabled();

    await page.goto(
      `/mux/session/${encodeURIComponent(sessionName)}`
      + `?workspace=${encodeURIComponent(workspaceIds[0])}`
      + `&tab=${encodeURIComponent(sessionName)}`,
    );
    const firstWorkspaceRegion = page.getByRole("region", { name: "Workspace quick links" });
    await firstWorkspaceRegion.getByRole("button", {
      name: "Manage workspace quick links",
    }).click();
    const removeDialog = page.getByRole("dialog", {
      name: `Manage ${firstName} links`,
    });
    await removeDialog.getByRole("button", { name: "Remove Launch ticket" }).click();
    await removeDialog.getByRole("button", { name: "Save links" }).click();
    await expect(firstWorkspaceRegion.getByRole("link", { name: "Launch ticket" }))
      .toHaveCount(0);
  } finally {
    try {
      await request.put("/mux/api/workspace-quick-links", { data: { links: [] } });
    } catch {
      // Keep global test state clean after a failed assertion.
    }
    for (const workspaceId of workspaceIds) {
      try {
        await request.delete(`/mux/api/workspaces/${encodeURIComponent(workspaceId)}`);
      } catch {
        // Keep workspace cleanup scoped to records created by this test.
      }
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

  await page.getByRole("button", { name: "Terminal", exact: true }).click();
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
  let terminalSocketCount = 0;
  let terminalInputFrameCount = 0;
  const terminalHistoryActions: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(message.text());
  });
  page.on("websocket", (socket) => {
    if (!socket.url().includes("/ws/terminal")) return;
    terminalSocketCount += 1;
    socket.on("framesent", ({ payload }) => {
      let isResize = false;
      let isHistory = false;
      if (typeof payload === "string") {
        try {
          const message = JSON.parse(payload) as { type?: string; action?: string };
          isResize = message.type === "resize";
          isHistory = message.type === "history";
          if (isHistory && message.action) terminalHistoryActions.push(message.action);
        } catch {
          // Plain strings are terminal input, just like binary frames.
        }
      }
      if (!isResize && !isHistory) terminalInputFrameCount += 1;
    });
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
  await page.getByRole("button", { name: "grok", exact: true }).click();
  await expect(page).toHaveURL(/\?kind=grok$/);
  await expect(page.getByRole("heading", { name: "No matching sessions" })).toBeVisible();
  await page.getByRole("button", { name: "copilot", exact: true }).click();
  await expect(page).toHaveURL(/\?kind=copilot$/);
  await expect(page.getByRole("heading", { name: "No matching sessions" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
    .toBe(true);
  await page.getByRole("button", { name: "shells", exact: true }).click();
  await expect(page.getByRole("button", { name: `Open ${sessionName}` })).toBeVisible();
  await page.getByRole("button", { name: "all", exact: true }).click();

  const memoOnlyTmuxBefore = workspaceTmuxSnapshot(sessionName);
  const cardMemoButton = page.getByRole("button", { name: `Manage memoranda for ${sessionName}` });
  await cardMemoButton.click();
  await expect(page).toHaveURL(/\/mux\/$/);
  let memoDialog = page.getByRole("dialog", { name: "Memo" });
  await expect(memoDialog).toBeVisible();
  const addMessage = memoDialog.getByRole("textbox", { name: "New memo" });
  await expect(addMessage).toHaveCSS("font-size", "16px");
  await addMessage.fill(originalQueuedCommand);
  const addForm = addMessage.locator("xpath=ancestor::form");
  await addForm.getByRole("button", { name: "Queue next" }).click();
  await addForm.getByRole("button", { name: "Save memo" }).click();
  await expect(memoDialog.locator(".mq-message-text")).toHaveText(originalQueuedCommand);
  await expect(memoDialog.getByText("Queued · 01")).toBeVisible();
  await memoDialog.getByRole("button", { name: "Close memo" }).click();
  const queuedCardMemoButton = page.getByRole("button", {
    name: `Manage memoranda for ${sessionName}, 1 queued`,
  });
  await expect(queuedCardMemoButton.locator("span")).toHaveText("Q1", { timeout: 10_000 });
  expect(workspaceTmuxSnapshot(sessionName)).toBe(memoOnlyTmuxBefore);

  await page.getByRole("button", { name: "List" }).click();
  await expect(page.getByRole("button", { name: "List" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(page.locator(".session-row")).toHaveCount(1);
  const rowMemoButton = page.getByRole("button", {
    name: `Manage memoranda for ${sessionName}, 1 queued`,
  });
  await rowMemoButton.click();
  await expect(page).toHaveURL(/\/mux\/\?view=list$/);
  memoDialog = page.getByRole("dialog", { name: "Memo" });
  await expect(memoDialog).toBeVisible();
  await expect(memoDialog).toHaveAttribute("aria-busy", "false", { timeout: 10_000 });
  await expect(memoDialog.locator(".mq-message-text")).toHaveText(originalQueuedCommand);
  await memoDialog.getByRole("button", { name: "Edit", exact: true }).click();
  const editMessage = memoDialog.getByRole("textbox", { name: "Edit memo 1" });
  await expect(editMessage).toHaveCSS("font-size", "16px");
  await editMessage.fill(editedQueuedCommand);
  await memoDialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(memoDialog.locator(".mq-message-text")).toHaveText(editedQueuedCommand);
  await memoDialog.getByRole("button", { name: "Close memo" }).click();
  expect(workspaceTmuxSnapshot(sessionName)).toBe(memoOnlyTmuxBefore);
  await page.screenshot({ path: "artifacts/dashboard-mobile-list.png", fullPage: true });
  await page.getByRole("button", { name: "Group State / attention" }).click();
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
  await page.getByRole("button", { name: `Edit title and tags for ${sessionName}` }).click();
  await page.getByRole("textbox", { name: "Human title" }).fill("Browser E2E");
  await page.getByRole("button", { name: "Save details" }).click();
  await expect(page.getByRole("button", { name: "Open Browser E2E" })).toBeVisible();
  await page.getByRole("button", { name: "Open Browser E2E" }).click();
  await expect(page.locator(".connection-badge")).toContainText("Live", { timeout: 10_000 });
  const mobileFocus = page.getByRole("navigation", { name: "Mobile console focus" });
  const mobileTerminalMode = mobileFocus.getByRole("button", { name: "Terminal", exact: true });
  const mobileInputMode = mobileFocus.locator(".mobile-console-focus-button.input");
  await expect(mobileTerminalMode).toHaveAttribute("aria-pressed", "true");
  await mobileInputMode.click();
  await expect(mobileInputMode).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("button", { name: "Raw terminal keyboard" })).toBeEnabled();
  let stagedInput = page.getByRole("textbox", { name: "Staged input" });
  await expect(stagedInput).toBeVisible();
  await expect(stagedInput).toHaveCSS("font-size", "16px");

  await page.getByRole("button", { name: "Edit title and tags" }).click();
  await page.getByRole("textbox", { name: "Human title" }).fill("Console E2E");
  await page.getByRole("button", { name: "Save details" }).click();
  await mobileTerminalMode.click();
  await expect(page.getByRole("heading", { name: "Console E2E" })).toBeVisible();
  await mobileInputMode.click();

  const retainedCommand = "for i in $(seq 1 100); do echo BROWSER_E2E_OK_$i; done";
  await stagedInput.fill(retainedCommand);
  await expect.poll(() => page.evaluate(
    (key) => window.localStorage.getItem(key),
    `muxdeck-terminal-draft:${sessionName}`,
  )).toBe(retainedCommand);
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(mobileTerminalMode).toHaveAttribute("aria-pressed", "true");
  await mobileInputMode.click();
  stagedInput = page.getByRole("textbox", { name: "Staged input" });
  await expect(stagedInput).toBeVisible();
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

  await mobileTerminalMode.click();
  const terminalControls = page.getByRole("navigation", { name: "Terminal view controls" });
  const rawPageUp = terminalControls.getByRole("button", {
    name: "Raw terminal Page Up",
  });
  const rawPageDown = terminalControls.getByRole("button", {
    name: "Raw terminal Page Down",
  });
  const tmuxPageUp = terminalControls.getByRole("button", {
    name: "Tmux Page Up",
  });
  const tmuxPageDown = terminalControls.getByRole("button", {
    name: "Tmux Page Down",
  });
  const returnToLive = terminalControls.getByRole("button", {
    name: "Return to live terminal",
  });
  await expect(terminalControls).toBeVisible();
  await expect(page.getByRole("group", { name: "Terminal input shortcuts" })).toBeHidden();
  const shell = page.locator(".console-shell");
  await expect(shell).toHaveAttribute("data-scroll-agent", "shells");
  await expect(shell).toHaveAttribute("data-scroll-mode", "tmux");
  await expect(tmuxPageUp).toHaveClass(/preferred-scroll-control/);
  await expect(tmuxPageDown).toHaveClass(/preferred-scroll-control/);
  await expect(rawPageUp).not.toHaveClass(/preferred-scroll-control/);
  await expect(rawPageDown).not.toHaveClass(/preferred-scroll-control/);
  const portraitRailButtons = terminalControls.getByRole("button");
  await expect(portraitRailButtons).toHaveCount(7);
  for (const button of await portraitRailButtons.all()) {
    const box = await button.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.width).toBeGreaterThanOrEqual(44);
    expect(box!.height).toBeGreaterThanOrEqual(44);
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(390);
  }
  expect(await terminalControls.evaluate((element) => (
    element.scrollWidth <= element.clientWidth
  ))).toBe(true);
  const historyPaneFormat = (format: string) => execFileSync(
    "tmux",
    [...tmux, "display-message", "-p", "-t", paneId, format],
    { encoding: "utf8" },
  ).trim();
  const inputFramesBeforeControls = terminalInputFrameCount;
  const historyFramesBefore = terminalHistoryActions.length;
  const terminalKeyboardTarget = page.locator(".terminal-host .xterm-helper-textarea");
  await terminalKeyboardTarget.focus();
  await expect(terminalKeyboardTarget).toBeFocused();

  await rawPageUp.click();
  await expect(terminalKeyboardTarget).toBeFocused();
  await expect(shell).toHaveAttribute("data-scroll-mode", "application");
  await expect(rawPageUp).toHaveClass(/preferred-scroll-control/);
  await expect(rawPageDown).toHaveClass(/preferred-scroll-control/);
  await rawPageDown.click();
  await expect(terminalKeyboardTarget).toBeFocused();

  await expect.poll(() => terminalInputFrameCount).toBe(inputFramesBeforeControls + 2);
  expect(terminalHistoryActions.slice(historyFramesBefore)).toEqual([]);
  await expect.poll(() => historyPaneFormat("#{pane_in_mode}")).toBe("0");
  const inputFramesAfterRawControls = terminalInputFrameCount;

  await tmuxPageUp.click();
  await expect(terminalKeyboardTarget).toBeFocused();
  await expect(shell).toHaveAttribute("data-scroll-mode", "tmux");
  await expect(tmuxPageUp).toHaveClass(/preferred-scroll-control/);
  await expect(tmuxPageDown).toHaveClass(/preferred-scroll-control/);

  await expect.poll(() => terminalHistoryActions.slice(historyFramesBefore))
    .toEqual(["page-up"]);
  await expect.poll(() => historyPaneFormat("#{pane_in_mode}")).toBe("1");
  await expect.poll(() => Number(historyPaneFormat("#{scroll_position}"))).toBeGreaterThan(0);
  const historyScrollPosition = Number(historyPaneFormat("#{scroll_position}"));
  expect(terminalInputFrameCount).toBe(inputFramesAfterRawControls);

  await tmuxPageDown.click();
  await expect(terminalKeyboardTarget).toBeFocused();

  await expect.poll(() => terminalHistoryActions.slice(historyFramesBefore))
    .toEqual(["page-up", "page-down"]);
  await expect.poll(() => Number(historyPaneFormat("#{scroll_position}")))
    .toBeLessThan(historyScrollPosition);
  expect(terminalInputFrameCount).toBe(inputFramesAfterRawControls);

  await returnToLive.click();
  await expect(terminalKeyboardTarget).toBeFocused();

  await expect.poll(() => terminalHistoryActions.slice(historyFramesBefore))
    .toEqual(["page-up", "page-down", "exit"]);
  await expect.poll(() => historyPaneFormat("#{pane_in_mode}")).toBe("0");
  expect(terminalInputFrameCount).toBe(inputFramesAfterRawControls);

  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setSafeAreaInsetsOverride", {
    insets: { top: 47, bottom: 34, left: 0, right: 0 },
  });
  await expect.poll(() => terminalControls.evaluate((element) => (
    getComputedStyle(element).paddingBottom
  ))).toBe("39px");
  const terminalStage = page.locator(".terminal-stage");
  const terminalElement = page.locator(".terminal-host .xterm");
  const standardTerminalHeight = (await terminalStage.boundingBox())!.height;
  const standardPaneHeight = Number(historyPaneFormat("#{pane_height}"));
  const socketsBeforeDistractionFree = terminalSocketCount;
  const historyBeforeDistractionFree = await page.evaluate(() => window.history.length);
  const urlBeforeDistractionFree = page.url();
  await terminalElement.evaluate((element) => {
    Object.defineProperty(window, "__muxdeckTerminalElement", { value: element });
  });

  const enterDistractionFree = terminalControls.getByRole("button", {
    name: "Enter distraction-free terminal",
  });
  await enterDistractionFree.click();
  await expect(terminalKeyboardTarget).toBeFocused();

  await expect(page.locator(".console-shell")).toHaveAttribute(
    "data-mobile-distraction-free",
    "true",
  );
  await expect(page.getByRole("navigation", { name: "Mobile console focus" })).toBeHidden();
  await expect(page.locator(".console-header")).toBeHidden();
  await expect(page.locator(".console-session-navigation")).toBeHidden();
  await expect(page.locator(".input-dock")).toBeHidden();
  await expect(terminalStage).toBeVisible();
  await expect(terminalControls).toBeVisible();
  const exitDistractionFree = terminalControls.getByRole("button", {
    name: "Exit distraction-free terminal",
  });
  await expect(exitDistractionFree).toHaveAttribute("aria-pressed", "true");
  await expect(exitDistractionFree).toHaveCSS("min-height", "44px");
  expect((await terminalStage.boundingBox())!.height).toBeGreaterThan(standardTerminalHeight);
  await expect.poll(() => Number(historyPaneFormat("#{pane_height}")))
    .toBeGreaterThan(standardPaneHeight);
  const focusedPaneHeight = Number(historyPaneFormat("#{pane_height}"));
  const focusedGeometry = await page.evaluate(() => {
    const shell = document.querySelector<HTMLElement>(".console-shell")!;
    const view = document.querySelector<HTMLElement>(".terminal-view")!;
    const stage = document.querySelector<HTMLElement>(".terminal-stage")!;
    const host = document.querySelector<HTMLElement>(".terminal-host")!;
    const xterm = document.querySelector<HTMLElement>(".terminal-host .xterm")!;
    const controls = document.querySelector<HTMLElement>(".terminal-view-controls")!;
    const viewport = window.visualViewport!;
    const shellRect = shell.getBoundingClientRect();
    const viewRect = view.getBoundingClientRect();
    const stageRect = stage.getBoundingClientRect();
    const xtermRect = xterm.getBoundingClientRect();
    const controlsRect = controls.getBoundingClientRect();
    const stageStyle = getComputedStyle(stage);
    const hostStyle = getComputedStyle(host);
    return {
      viewportTop: viewport.offsetTop,
      viewportBottom: viewport.offsetTop + viewport.height,
      viewportHeight: viewport.height,
      shellTop: shellRect.top,
      shellBottom: shellRect.bottom,
      viewTop: viewRect.top,
      stageTop: stageRect.top,
      stageBottom: stageRect.bottom,
      stageHeight: stageRect.height,
      xtermTop: xtermRect.top,
      controlsTop: controlsRect.top,
      controlsBottom: controlsRect.bottom,
      controlsHeight: controlsRect.height,
      shellPaddingBottom: getComputedStyle(shell).paddingBottom,
      stagePaddingTop: stageStyle.paddingTop,
      stagePaddingBottom: stageStyle.paddingBottom,
      hostPaddingTop: hostStyle.paddingTop,
      hostPaddingBottom: hostStyle.paddingBottom,
    };
  });
  const expectWithinPixel = (left: number, right: number) => {
    expect(Math.abs(left - right)).toBeLessThanOrEqual(1);
  };
  expectWithinPixel(focusedGeometry.shellTop, focusedGeometry.viewportTop);
  expectWithinPixel(focusedGeometry.viewTop, focusedGeometry.viewportTop);
  expectWithinPixel(focusedGeometry.stageTop, focusedGeometry.viewportTop);
  expectWithinPixel(focusedGeometry.xtermTop, focusedGeometry.stageTop);
  expectWithinPixel(focusedGeometry.stageBottom, focusedGeometry.controlsTop);
  expectWithinPixel(focusedGeometry.controlsBottom, focusedGeometry.viewportBottom);
  expectWithinPixel(focusedGeometry.shellBottom, focusedGeometry.viewportBottom);
  expectWithinPixel(
    focusedGeometry.stageHeight + focusedGeometry.controlsHeight,
    focusedGeometry.viewportHeight,
  );
  expect(focusedGeometry).toMatchObject({
    shellPaddingBottom: "0px",
    stagePaddingTop: "0px",
    stagePaddingBottom: "0px",
    hostPaddingTop: "0px",
    hostPaddingBottom: "0px",
  });
  expect(await terminalElement.evaluate((element) => (
    element === (window as Window & { __muxdeckTerminalElement: Element }).__muxdeckTerminalElement
  ))).toBe(true);
  expect(terminalSocketCount).toBe(socketsBeforeDistractionFree);
  expect(await page.evaluate(() => window.history.length)).toBe(historyBeforeDistractionFree);
  expect(page.url()).toBe(urlBeforeDistractionFree);
  expect(await page.evaluate(() => (
    document.documentElement.scrollWidth <= window.innerWidth
    && document.documentElement.scrollHeight <= window.innerHeight
  ))).toBe(true);
  await page.screenshot({ path: "artifacts/terminal-mobile-distraction-free.png" });

  await exitDistractionFree.click();
  await expect(terminalKeyboardTarget).toBeFocused();
  await expect(page.locator(".console-shell")).toHaveAttribute(
    "data-mobile-distraction-free",
    "false",
  );
  await expect(page.getByRole("navigation", { name: "Mobile console focus" })).toBeVisible();
  await expect(page.locator(".console-header")).toBeVisible();
  await expect.poll(() => Number(historyPaneFormat("#{pane_height}")))
    .toBeLessThan(focusedPaneHeight);
  expect(await terminalElement.evaluate((element) => (
    element === (window as Window & { __muxdeckTerminalElement: Element }).__muxdeckTerminalElement
  ))).toBe(true);
  expect(terminalSocketCount).toBe(socketsBeforeDistractionFree);
  await cdp.send("Emulation.setSafeAreaInsetsOverride", { insets: {} });
  await page.setViewportSize({ width: 320, height: 700 });
  const enlargedRailText = await page.addStyleTag({
    content: ".terminal-view-control { font-size: 18px !important; }",
  });
  const reflowedRailButtons = terminalControls.getByRole("button");
  const reflowedBoxes = await Promise.all(
    (await reflowedRailButtons.all()).map((button) => button.boundingBox()),
  );
  expect(reflowedBoxes.every((box) => box !== null && box.width >= 44 && box.height >= 44))
    .toBe(true);
  expect(reflowedBoxes.slice(0, 4).every((box) => box!.y === reflowedBoxes[0]!.y)).toBe(true);
  expect(reflowedBoxes[4]!.y).toBeGreaterThan(reflowedBoxes[0]!.y);
  expect(await terminalControls.evaluate((element) => (
    element.scrollWidth <= element.clientWidth
  ))).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
    .toBe(true);
  await enlargedRailText.evaluate((element) => element.remove());
  await page.setViewportSize({ width: 932, height: 430 });
  await expect(terminalControls).toBeVisible();
  const landscapePurposeButtons = page.getByRole("navigation", {
    name: "Mobile console focus",
  }).getByRole("button");
  await expect(landscapePurposeButtons).toHaveCount(3);
  const landscapeRailButtons = terminalControls.getByRole("button");
  await expect(landscapeRailButtons).toHaveCount(7);
  for (const button of await landscapeRailButtons.all()) {
    const box = await button.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.width).toBeGreaterThanOrEqual(44);
    expect(box!.height).toBeGreaterThanOrEqual(44);
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(932);
  }
  expect(await terminalControls.evaluate((element) => (
    element.scrollWidth <= element.clientWidth
  ))).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
    .toBe(true);
  await page.setViewportSize({ width: 390, height: 844 });
  await mobileInputMode.click();

  await expect(mobileInputMode).toHaveAccessibleName("Input, 1 queued memo item");
  await expect(mobileInputMode.locator(".mobile-console-memo-count")).toHaveText("Q 1");
  const directMemoButton = page.locator(".composer-memo-open");
  await expect(directMemoButton).toBeVisible();
  await expect(directMemoButton).toHaveAccessibleName("Open memo, 1 queued");
  await directMemoButton.click();
  memoDialog = page.getByRole("dialog", { name: "Memo" });
  await memoDialog.getByRole("button", { name: "Stage", exact: true }).click();
  await expect(memoDialog).not.toBeVisible();
  await expect(mobileInputMode).toHaveAccessibleName("Input");
  await expect(mobileInputMode.locator(".mobile-console-memo-count")).toHaveCount(0);
  await expect(directMemoButton).toHaveAccessibleName("Open memo, 1 saved");
  await expect(stagedInput).toHaveValue(editedQueuedCommand);
  await page.getByRole("button", { name: "Send + Enter" }).click();
  await expect(stagedInput).toHaveValue("");
  await expect.poll(() => {
    return execFileSync("tmux", [...tmux, "capture-pane", "-p", "-t", paneId], { encoding: "utf8" });
  }).toContain("MEMO_QUEUE_EDITED");
  await expect(directMemoButton).toHaveAccessibleName("Open memo");

  await directMemoButton.click();
  memoDialog = page.getByRole("dialog", { name: "Memo" });
  await expect(memoDialog.getByText("Your memo is empty.")).toBeVisible();
  await memoDialog.getByRole("button", { name: "Close memo" }).click();
  await expect(page.locator(".memo-key")).toHaveAccessibleName("Open memoranda");

  await page.setViewportSize({ width: 320, height: 700 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(await page.locator(".staged-composer").evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  const terminalShortcuts = page.getByRole("group", { name: "Terminal input shortcuts" });
  expect(await terminalShortcuts.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
  const primaryShortcuts = [
    page.getByRole("button", { name: "Edit title and tags" }),
    page.getByRole("button", { name: "Rename tmux session" }),
    page.locator(".memo-key"),
    page.getByRole("button", { name: "Open snippets" }),
  ];
  for (const shortcut of primaryShortcuts) {
    await expect(shortcut).toHaveCSS("position", "static");
  }
  const otherKeysToggle = terminalShortcuts.locator(".other-keys-toggle");
  await expect(otherKeysToggle).toHaveAccessibleName("Show other keys");
  await expect(otherKeysToggle).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByRole("group", { name: "Other keys" })).toHaveCount(0);
  await otherKeysToggle.scrollIntoViewIfNeeded();
  await expect(otherKeysToggle).toBeInViewport();
  const shortcutTrayBox = await terminalShortcuts.boundingBox();
  const otherKeysBox = await otherKeysToggle.boundingBox();
  expect(shortcutTrayBox).not.toBeNull();
  expect(otherKeysBox).not.toBeNull();
  expect(otherKeysBox!.x).toBeGreaterThanOrEqual(shortcutTrayBox!.x);
  expect(otherKeysBox!.x + otherKeysBox!.width)
    .toBeLessThanOrEqual(shortcutTrayBox!.x + shortcutTrayBox!.width);
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
  await directMemoButton.click();
  memoDialog = page.getByRole("dialog", { name: "Memo" });
  expect(await memoDialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await expect(memoDialog.getByRole("textbox", { name: "New memo" })).toHaveCSS("font-size", "16px");
  await memoDialog.getByRole("button", { name: "Close memo" }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  const captureJoinedPane = () => execFileSync(
    "tmux",
    [...tmux, "capture-pane", "-J", "-p", "-t", paneId],
    { encoding: "utf8" },
  );

  await stagedInput.fill("IFS= read -rsn4 key; printf 'PAGE_UP_KEY=%q\\n' \"$key\"");
  await page.getByRole("button", { name: "Send + Enter" }).click();
  await expect.poll(captureJoinedPane).toContain("read -rsn4 key");
  await page.getByRole("button", { name: "PgUp" }).click();
  await expect.poll(captureJoinedPane).toContain(String.raw`PAGE_UP_KEY=$'\E[5~'`);

  await stagedInput.fill("IFS= read -rsn4 key; printf 'PAGE_DOWN_KEY=%q\\n' \"$key\"");
  await page.getByRole("button", { name: "Send + Enter" }).click();
  await expect.poll(captureJoinedPane).toContain("PAGE_DOWN_KEY=%q");
  await page.getByRole("button", { name: "PgDn" }).click();
  await expect.poll(captureJoinedPane).toContain(String.raw`PAGE_DOWN_KEY=$'\E[6~'`);

  await stagedInput.fill("IFS= read -rsn1 key; printf 'CTRL_A_KEY=%q\\n' \"$key\"");
  await page.getByRole("button", { name: "Send + Enter" }).click();
  await expect.poll(captureJoinedPane).toContain("CTRL_A_KEY=%q");
  await page.getByRole("button", { name: "Ctrl+A - move to start of input" }).click();
  await expect.poll(captureJoinedPane).toContain(String.raw`CTRL_A_KEY=$'\001'`);

  await stagedInput.fill("IFS= read -rsn1 key; printf 'CTRL_E_KEY=%q\\n' \"$key\"");
  await page.getByRole("button", { name: "Send + Enter" }).click();
  await expect.poll(captureJoinedPane).toContain("CTRL_E_KEY=%q");
  await page.getByRole("button", { name: "Ctrl+E - move to end of input" }).click();
  await expect.poll(captureJoinedPane).toContain(String.raw`CTRL_E_KEY=$'\005'`);

  await stagedInput.fill("IFS= read -rsn1 key; printf 'CTRL_K_KEY=%q\\n' \"$key\"");
  await page.getByRole("button", { name: "Send + Enter" }).click();
  await expect.poll(captureJoinedPane).toContain("CTRL_K_KEY=%q");
  await page.getByRole("button", { name: "Ctrl+K - delete to end of input" }).click();
  await expect.poll(captureJoinedPane).toContain(String.raw`CTRL_K_KEY=$'\v'`);

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

  await mobileTerminalMode.click();
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

test("mobile memo exposes and clears queued work without touching tmux", async ({ page }) => {
  const memoSession = `${sessionName}-composer-memo`;
  const exactMemo = "  compare the two deploy traces\nthen keep the safer result  ";
  execFileSync("tmux", [
    ...tmux,
    "new-session",
    "-d",
    "-s",
    memoSession,
    "bash",
    "--noprofile",
    "--norc",
  ]);

  try {
    await page.setViewportSize({ width: 320, height: 700 });
    await page.goto(`/mux/session/${encodeURIComponent(memoSession)}`);
    await expect(page.locator(".connection-badge")).toContainText("Live", {
      timeout: 10_000,
    });
    const mobileFocus = page.getByRole("navigation", { name: "Mobile console focus" });
    const inputRail = mobileFocus.locator(".mobile-console-focus-button.input");
    await inputRail.click();

    const stagedInput = page.getByRole("textbox", { name: "Staged input" });
    await stagedInput.fill(exactMemo);
    const queueInMemo = page.getByRole("button", { name: "Queue in memo" });
    await expect(queueInMemo).toBeEnabled();
    const tmuxBefore = workspaceTmuxContentSnapshot(memoSession);

    await queueInMemo.click();

    await expect(stagedInput).toHaveValue("");
    await expect(page.locator(".composer-status"))
      .toContainText("Queued in this session's memo");
    await expect.poll(() => page.evaluate(
      (key) => window.localStorage.getItem(key),
      `muxdeck-terminal-draft:${memoSession}`,
    )).toBeNull();
    expect(workspaceTmuxContentSnapshot(memoSession)).toBe(tmuxBefore);

    await expect(inputRail).toHaveAccessibleName("Input, 1 queued memo item");
    const inputQueueBadge = inputRail.locator(".mobile-console-memo-count");
    await expect(inputQueueBadge).toHaveText("Q 1");
    await expect(inputQueueBadge).toBeVisible();
    await expect(inputQueueBadge).toBeInViewport();
    await expect(inputRail).toBeVisible();
    await expect(inputRail).toBeInViewport();
    const inputRailBox = await inputRail.boundingBox();
    const inputQueueBadgeBox = await inputQueueBadge.boundingBox();
    expect(inputRailBox).not.toBeNull();
    expect(inputQueueBadgeBox).not.toBeNull();
    expect(inputQueueBadgeBox!.x).toBeGreaterThanOrEqual(inputRailBox!.x - CSS_PIXEL_TOLERANCE);
    expect(inputQueueBadgeBox!.x + inputQueueBadgeBox!.width)
      .toBeLessThanOrEqual(inputRailBox!.x + inputRailBox!.width + CSS_PIXEL_TOLERANCE);
    expect(inputQueueBadgeBox!.y).toBeGreaterThanOrEqual(inputRailBox!.y - CSS_PIXEL_TOLERANCE);
    expect(inputQueueBadgeBox!.y + inputQueueBadgeBox!.height)
      .toBeLessThanOrEqual(inputRailBox!.y + inputRailBox!.height + CSS_PIXEL_TOLERANCE);

    const directMemo = page.locator(".composer-memo-open");
    await expect(directMemo).toHaveAccessibleName("Open memo, 1 queued");
    await expect(directMemo.locator(".memo-count.queued")).toHaveText("Q 1");
    await expect(directMemo).toBeVisible();
    await expect(directMemo).toBeInViewport();
    expect(await page.locator(".composer-mobile-controls").evaluate((element) => (
      element.scrollWidth <= element.clientWidth
    ))).toBe(true);

    const terminalShortcuts = page.getByRole("group", { name: "Terminal input shortcuts" });
    const shortcutMemo = terminalShortcuts.locator(".memo-key");
    expect(await terminalShortcuts.evaluate((element) => element.scrollLeft)).toBe(0);
    await expect(shortcutMemo).toHaveAccessibleName("Open memoranda, 1 queued");
    await expect(shortcutMemo).toBeVisible();
    await expect(shortcutMemo).toBeInViewport();
    const shortcutTrayBox = await terminalShortcuts.boundingBox();
    const shortcutMemoBox = await shortcutMemo.boundingBox();
    expect(shortcutTrayBox).not.toBeNull();
    expect(shortcutMemoBox).not.toBeNull();
    expect(shortcutMemoBox!.x).toBeGreaterThanOrEqual(shortcutTrayBox!.x);
    expect(shortcutMemoBox!.x + shortcutMemoBox!.width)
      .toBeLessThanOrEqual(shortcutTrayBox!.x + shortcutTrayBox!.width);

    const actions = page.locator(".composer-actions-primary");
    expect(await actions.evaluate((element) => element.scrollWidth <= element.clientWidth))
      .toBe(true);
    const actionButtons = [
      page.getByRole("button", { name: "Clear" }),
      page.getByRole("button", { name: "Send", exact: true }),
      page.getByRole("button", { name: "Send + Enter" }),
      queueInMemo,
      page.getByRole("button", { name: "Send + Tab" }),
    ];
    const actionBoxes = [];
    for (const button of actionButtons) {
      const box = await button.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.height).toBeGreaterThanOrEqual(44);
      actionBoxes.push(box!);
    }
    for (let leftIndex = 0; leftIndex < actionBoxes.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < actionBoxes.length; rightIndex += 1) {
        const left = actionBoxes[leftIndex];
        const right = actionBoxes[rightIndex];
        const overlaps = left.x < right.x + right.width - CSS_PIXEL_TOLERANCE
          && left.x + left.width > right.x + CSS_PIXEL_TOLERANCE
          && left.y < right.y + right.height - CSS_PIXEL_TOLERANCE
          && left.y + left.height > right.y + CSS_PIXEL_TOLERANCE;
        expect(overlaps).toBe(false);
      }
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
      .toBe(true);
    await page.screenshot({ path: "artifacts/composer-add-to-memo-mobile.png" });

    await directMemo.click();
    const memoDialog = page.getByRole("dialog", { name: "Memo" });
    await expect(memoDialog.locator(".mq-message-text")).toHaveText(exactMemo);
    const memoItem = memoDialog.getByRole("listitem");
    await expect(memoItem.getByText("Queued · 01")).toBeVisible();

    await memoItem.getByRole("button", { name: "Move to notes" }).click();
    await expect(memoDialog.getByText("Memo moved to notes.")).toBeVisible();
    await expect(inputRail).toHaveAccessibleName("Input");
    await expect(inputRail.locator(".mobile-console-memo-count")).toHaveCount(0);
    await expect(directMemo).toHaveAccessibleName("Open memo, 1 saved");
    await expect(directMemo.locator(".memo-count.queued")).toHaveCount(0);
    await expect(shortcutMemo).toHaveAccessibleName("Open memoranda, 1 saved");
    expect(workspaceTmuxContentSnapshot(memoSession)).toBe(tmuxBefore);

    await memoItem.getByRole("button", { name: "Queue next" }).click();
    await expect(memoDialog.getByText("Memo added to the input queue.")).toBeVisible();
    await expect(inputRail).toHaveAccessibleName("Input, 1 queued memo item");
    await expect(inputRail.locator(".mobile-console-memo-count")).toHaveText("Q 1");
    await expect(directMemo).toHaveAccessibleName("Open memo, 1 queued");
    await expect(shortcutMemo).toHaveAccessibleName("Open memoranda, 1 queued");
    expect(workspaceTmuxContentSnapshot(memoSession)).toBe(tmuxBefore);

    await memoItem.getByRole("button", { name: "Delete", exact: true }).click();
    await memoItem.getByRole("button", { name: "Confirm delete" }).click();
    await expect(memoDialog.getByText("Your memo is empty.")).toBeVisible();
    await expect(inputRail).toHaveAccessibleName("Input");
    await expect(inputRail.locator(".mobile-console-memo-count")).toHaveCount(0);
    await expect(directMemo).toHaveAccessibleName("Open memo");
    await expect(shortcutMemo).toHaveAccessibleName("Open memoranda");
    expect(workspaceTmuxContentSnapshot(memoSession)).toBe(tmuxBefore);
  } finally {
    try {
      execFileSync("tmux", [...tmux, "kill-session", "-t", `=${memoSession}`], {
        stdio: "ignore",
      });
    } catch {
      // Cleanup stays scoped to this test's disposable tmux server.
    }
  }
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
      { data: { text: "Persist across native rename", state: "queued" } },
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
    const mobileInputMode = page.locator(".mobile-console-focus-button.input");
    await expect(mobileInputMode).toHaveAccessibleName("Input, 1 queued memo item");
    await mobileInputMode.click();

    const stagedInput = page.getByRole("textbox", { name: "Staged input" });
    await stagedInput.fill("keep this unsent draft");
    await expect.poll(() => page.evaluate(
      (key) => window.localStorage.getItem(key),
      `muxdeck-terminal-draft:${sessionName}`,
    )).toBe("keep this unsent draft");

    const terminalShortcuts = page.getByRole("group", { name: "Terminal input shortcuts" });
    const primaryShortcuts = [
      terminalShortcuts.getByRole("button", { name: "Raw terminal keyboard" }),
      terminalShortcuts.getByRole("button", { name: "Esc", exact: true }),
      terminalShortcuts.getByRole("button", { name: "Tab", exact: true }),
      terminalShortcuts.getByRole("button", { name: "^C", exact: true }),
      terminalShortcuts.getByRole("button", { name: "Enter", exact: true }),
      terminalShortcuts.getByRole("button", { name: "Ctrl+K - delete to end of input" }),
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
    expect(await terminalShortcuts.evaluate((element) => element.scrollLeft)).toBe(0);
    const queuedMemoShortcut = terminalShortcuts.locator(".memo-key");
    await expect(queuedMemoShortcut).toHaveAccessibleName("Open memoranda, 1 queued");
    await expect(queuedMemoShortcut).toBeInViewport();
    const terminalShortcutsBox = await terminalShortcuts.boundingBox();
    const queuedMemoShortcutBox = await queuedMemoShortcut.boundingBox();
    expect(terminalShortcutsBox).not.toBeNull();
    expect(queuedMemoShortcutBox).not.toBeNull();
    expect(queuedMemoShortcutBox!.x)
      .toBeGreaterThanOrEqual(terminalShortcutsBox!.x - CSS_PIXEL_TOLERANCE);
    expect(queuedMemoShortcutBox!.x + queuedMemoShortcutBox!.width)
      .toBeLessThanOrEqual(
        terminalShortcutsBox!.x + terminalShortcutsBox!.width + CSS_PIXEL_TOLERANCE,
      );
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
      .toBe(true);

    const aliasButton = page.getByRole("button", { name: "Edit title and tags" });
    const renameButton = page.getByRole("button", { name: "Rename tmux session" });
    await renameButton.scrollIntoViewIfNeeded();
    await expect(renameButton).toBeInViewport();
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
    await expect(page.getByRole("textbox", { name: "Staged input" }))
      .toHaveValue("keep this unsent draft");
    await page.getByRole("button", { name: "Terminal", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Rename E2E" })).toBeVisible();
    await expect(page.locator(".connection-badge")).toContainText("Live", {
      timeout: 10_000,
    });
    await expect(mobileInputMode).toHaveAccessibleName("Input, 1 queued memo item");
    await mobileInputMode.click();
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

    await page.getByRole("button", { name: "Terminal", exact: true }).click();
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
