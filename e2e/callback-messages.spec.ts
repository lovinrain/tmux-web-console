import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import type { CallbackMessage, SavedWorkspace } from "../src/api";
import { E2E_AUTH_PASSWORD, E2E_AUTH_USERNAME } from "./authFixture";

const workspaceIds: string[] = [];
const callbackIds: string[] = [];
let agentRequest: APIRequestContext;

test.use({ viewport: { width: 1440, height: 1000 } });

test.beforeEach(async ({ context, playwright, baseURL }) => {
  const tokenFile = process.env.MUXDECK_PLAYWRIGHT_CALLBACK_TOKEN_FILE;
  const callbacksFile = process.env.MUXDECK_PLAYWRIGHT_CALLBACKS_FILE;
  if (!tokenFile?.startsWith("/tmp/muxdeck-playwright-")
    || !callbacksFile?.startsWith("/tmp/muxdeck-playwright-")) {
    throw new Error("Callback fixtures require the disposable Playwright token and database");
  }
  // This context has no browser cookies: scripts authenticate only with the
  // disposable callback credential, never the live console configuration.
  agentRequest = await playwright.request.newContext({
    baseURL,
    extraHTTPHeaders: { Authorization: `Bearer ${readFileSync(tokenFile, "utf8").trim()}` },
  });
  const response = await context.request.post("/mux/api/auth/login", {
    data: { username: E2E_AUTH_USERNAME, password: E2E_AUTH_PASSWORD },
  });
  expect(response.ok()).toBe(true);
  await context.addInitScript(() => {
    localStorage.setItem("muxdeck-desktop-tab-orientation", "vertical");
  });
});

test.afterEach(async ({ context }) => {
  await Promise.all(context.pages().map((page) => page.close()));
  for (const id of callbackIds.splice(0)) {
    expect((await agentRequest.post(`/mux/api/callback-messages/${id}/review`)).ok()).toBe(true);
  }
  for (const id of workspaceIds.splice(0)) {
    expect((await context.request.delete(`/mux/api/workspaces/${id}`)).ok()).toBe(true);
  }
  await agentRequest.dispose();
  // The server owns the open SQLite database across workers, like the session
  // registry. Do not unlink it or the credential while other specs can use it.
});

async function openCallbackPanel(page: Page, workspace: SavedWorkspace): Promise<void> {
  const query = new URLSearchParams({ workspace: workspace.id });
  await page.goto(`/mux/?${query}`);
  await expect(page.getByRole("heading", { name: workspace.name, exact: true })).toBeVisible();
  const show = page.getByRole("button", { name: "Show callback list", exact: true });
  if (await show.count()) await show.click();
  await expect(page.getByRole("dialog", { name: "Callback list", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Global callback scope", exact: true }).click();
}

test("agent reports reach both tabs, review independently, and remain readable as durable history", async ({
  page, context,
}, testInfo) => {
  const sessionName = `missing-callback-${randomUUID()}`;
  const response = await context.request.post("/mux/api/workspaces", {
    data: {
      name: "Agent completion review", tabs: [sessionName], activeSession: sessionName,
      groups: [{ id: "callback-fixture", name: "Completed work", color: "blue", collapsed: false, tabs: [sessionName] }],
    },
  });
  expect(response.ok()).toBe(true);
  const workspace = (await response.json()).workspace as SavedWorkspace;
  workspaceIds.push(workspace.id);
  const secondPage = await context.newPage();
  await openCallbackPanel(page, workspace);
  await openCallbackPanel(secondPage, workspace);

  const report = {
    message: "Completed the callback endpoint. Literal markup: <img src=x onerror=alert(1)>",
    sessionName,
    agentType: "codex",
    cwd: "/tmp/callback-fixture/project with spaces",
    requestId: randomUUID(),
    tmuxSessionId: "$314",
    tmuxPaneId: "%159",
    host: "callback-fixture.local",
  };
  const created = await agentRequest.post("/mux/api/callback-messages", { data: report });
  expect(created.status()).toBe(201);
  const { callback: first, duplicate } = await created.json() as { callback: CallbackMessage; duplicate: boolean };
  callbackIds.push(first.id);
  expect(duplicate).toBe(false);
  expect(first).toMatchObject({ ...report, reviewedAt: null });

  const retried = await agentRequest.post("/mux/api/callback-messages", { data: report });
  expect(retried.status()).toBe(200);
  expect(await retried.json()).toMatchObject({ callback: { id: first.id }, duplicate: true });
  const secondReport = { ...report, message: "Documentation and deployment checks are complete.", agentType: "claude", requestId: randomUUID() };
  const secondCreated = await agentRequest.post("/mux/api/callback-messages", { data: secondReport });
  expect(secondCreated.status()).toBe(201);
  const second = (await secondCreated.json()).callback as CallbackMessage;
  callbackIds.push(second.id);

  // No reload or manual refresh: workspace event streams deliver both reports.
  for (const current of [page, secondPage]) {
    const panel = current.getByRole("dialog", { name: "Callback list", exact: true });
    await expect(panel.getByText(report.message, { exact: true })).toBeVisible();
    await expect(panel.getByText(secondReport.message, { exact: true })).toBeVisible();
    await expect(panel.locator(".workspace-callback-message")).toHaveCount(2);
    await expect(panel.locator(".workspace-callback-message-cwd").first()).toHaveText(report.cwd);
    await expect(panel.locator(".workspace-callback-message-origin").first())
      .toHaveText("callback-fixture.local · $314 · %159");
    await expect(panel.locator("img")).toHaveCount(0);
    await expect(panel.getByRole("button", { name: `Open ${sessionName}`, exact: true })).toBeDisabled();
  }
  const panel = page.getByRole("dialog", { name: "Callback list", exact: true });
  await panel.screenshot({ path: testInfo.outputPath("callback-messages-dark.png") });
  await page.evaluate(() => window.dispatchEvent(new Event("muxdeck:toggle-theme")));
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await panel.screenshot({ path: testInfo.outputPath("callback-messages-light.png") });

  await panel.getByRole("button", { name: `Mark message from codex in ${sessionName} reviewed`, exact: true }).click();
  for (const current of [page, secondPage]) {
    const currentPanel = current.getByRole("dialog", { name: "Callback list", exact: true });
    await expect(currentPanel.getByText(report.message, { exact: true })).toHaveCount(0);
    await expect(currentPanel.getByText(secondReport.message, { exact: true })).toBeVisible();
  }
  await page.reload();
  await expect(page.locator(".dashboard-shell")).toBeVisible();
  const showPanel = page.getByRole("button", { name: "Show callback list", exact: true });
  if (await showPanel.count()) await showPanel.click();
  await expect(page.getByText(secondReport.message, { exact: true })).toBeVisible();
  await expect(page.getByText(report.message, { exact: true })).toHaveCount(0);

  const pending = await agentRequest.get(`/mux/api/callback-messages?status=pending&after=${first.sequence - 1}`);
  expect(pending.ok()).toBe(true);
  expect((await pending.json()).messages.map((message: CallbackMessage) => message.id)).toEqual([second.id]);
  const history = await agentRequest.get(`/mux/api/callback-messages?status=all&after=${first.sequence - 1}&limit=1`);
  expect(history.ok()).toBe(true);
  const historyPage = await history.json();
  expect(historyPage.messages).toEqual([expect.objectContaining({ ...report, id: first.id, reviewedAt: expect.any(Number) })]);
  expect(historyPage.nextAfter).toBe(first.sequence);
  const next = await agentRequest.get(`/mux/api/callback-messages?status=all&after=${historyPage.nextAfter}&limit=1`);
  expect(next.ok()).toBe(true);
  expect((await next.json()).messages).toEqual([expect.objectContaining({ id: second.id, reviewedAt: null })]);

  await secondPage.close();
  await page.goto("/mux/");
  await expect(page.locator(".dashboard-shell")).toBeVisible();
  const dashboardShow = page.getByRole("button", { name: "Show callback list", exact: true });
  if (await dashboardShow.count()) await dashboardShow.click();
  await expect(page.getByRole("dialog", { name: "Callback list", exact: true })
    .getByText(secondReport.message, { exact: true })).toBeVisible();
});

test("a script credential can read callbacks but cannot inspect or control sessions", async ({ playwright, baseURL }) => {
  expect((await agentRequest.get("/mux/api/callback-messages?status=all")).ok()).toBe(true);
  expect((await agentRequest.get("/mux/api/sessions")).status()).toBe(403);
  expect((await agentRequest.post("/mux/api/workspaces", {
    data: { name: "Unauthorized workspace", tabs: [] },
  })).status()).toBe(403);
  const anonymous = await playwright.request.newContext({ baseURL });
  try {
    expect((await anonymous.get("/mux/api/callback-messages")).status()).toBe(401);
    expect((await anonymous.get("/mux/api/callback-messages", {
      headers: { Authorization: `Bearer ${"invalid-callback-token-".repeat(3)}` },
    })).status()).toBe(401);
  } finally {
    await anonymous.dispose();
  }
});
