import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { test, expect } from "@playwright/test";

const sessionName = `muxdeck-browser-${process.pid}`;
const socketName = process.env.MUXDECK_PLAYWRIGHT_TMUX_SOCKET || "muxdeck-playwright-test";
const tmux = ["-L", socketName];
const titlesFile = process.env.MUXDECK_PLAYWRIGHT_TITLES_FILE;
const messagesFile = process.env.MUXDECK_PLAYWRIGHT_MESSAGES_FILE;
const snippetsFile = process.env.MUXDECK_PLAYWRIGHT_SNIPPETS_FILE;
const originalQueuedCommand = "printf 'MEMO_QUEUE_ORIGINAL\\n'";
const editedQueuedCommand = "printf 'MEMO_QUEUE_EDITED\\n'";
let paneId = "";

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
  const columns = await page.locator(".session-grid").evaluate((element) => {
    return getComputedStyle(element).gridTemplateColumns.split(" ").length;
  });
  expect(columns).toBe(3);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: "artifacts/dashboard-desktop.png" });
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
  await expect(newWindow).toHaveURL(`/mux/session/${sessionName}${dashboardUrl.slice(5)}`);
  await expect(newWindow.getByRole("button", { name: "Back to sessions" })).toBeVisible();
  await expect(page).toHaveURL(dashboardUrl);
  await newWindow.close();

  await page.getByRole("button", { name: `Open ${sessionName}` }).click();
  await expect(page).toHaveURL(new RegExp(`/mux/session/${sessionName}\\?`));
  await page.goBack();
  await expect(page).toHaveURL(dashboardUrl);
  await expect(page.getByLabel("Find a session")).toHaveValue(sessionName);
  await page.goForward();
  await expect(page.getByRole("button", { name: "Back to sessions" })).toBeVisible();
  await page.getByRole("button", { name: "Back to sessions" }).click();
  await expect(page).toHaveURL(dashboardUrl);

  await page.goto(`/mux/session/${sessionName}?kind=shells&view=list&sort=title,tmux-name`);
  await page.getByRole("button", { name: "Back to sessions" }).click();
  await expect(page).toHaveURL("/mux/?kind=shells&view=list&sort=title,tmux-name");
  await expect(page.getByRole("button", { name: "List" })).toHaveAttribute("aria-pressed", "true");
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

  await expect(page).toHaveURL(`/mux/session/${sessionName}`);
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

  await page.getByRole("button", { name: "Update session name" }).click();
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
  await expect(page.getByRole("button", { name: "Send + Enter" })).toBeEnabled({ timeout: 10_000 });
  await page.getByRole("button", { name: "Send + Enter" }).click();
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
  await page.screenshot({ path: "artifacts/console-mobile.png" });

  await page.getByRole("button", { name: "History" }).click();
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
