import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import type { RecoverableSession, SavedWorkspace } from "../src/api";
import type { Session } from "../src/types";
import { E2E_AUTH_PASSWORD, E2E_AUTH_USERNAME } from "./authFixture";

const workspaceIds: string[] = [];
const recoveryIds: string[] = [];
let fixtureSequence = 0;

const recoveryCard = (page: Page, name: string) => page.locator(".recovery-card").filter({
  has: page.locator(".recovery-card-heading strong", { hasText: name }),
});
const tabRow = (page: Page, name: string) => page.locator(
  `.workspace-tab[data-workspace-session-name="${name}"]`,
);
const undoButton = (page: Page, name: string) => page.getByRole("button", {
  name: `Undo forgetting ${name}`, exact: true,
});

test.use({ viewport: { width: 1440, height: 850 } });

test.beforeEach(async ({ context }) => {
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
  for (const id of workspaceIds.splice(0)) {
    expect((await context.request.delete(`/mux/api/workspaces/${id}`)).ok()).toBe(true);
  }
  for (const id of recoveryIds.splice(0)) {
    const response = await context.request.delete(`/mux/api/recoverable-sessions/${id}`);
    expect([200, 204, 404]).toContain(response.status());
  }
});

function seedRecoveries(prefix: string, count: number): RecoverableSession[] {
  const registryPath = process.env.MUXDECK_PLAYWRIGHT_SESSION_REGISTRY_FILE;
  if (!registryPath?.startsWith("/tmp/muxdeck-playwright-")) {
    throw new Error("Recovery fixtures require the disposable Playwright registry");
  }
  const localPython = resolve(".venv/bin/python");
  const python = process.env.MUXDECK_PLAYWRIGHT_PYTHON
    || (existsSync(localPython) ? localPython : "/usr/bin/python3");
  const sequence = ++fixtureSequence;
  const names = Array.from({ length: count }, (_, index) => `${prefix}-${sequence}-${index}`);
  // Register synthetic missing sessions without starting or stopping any tmux process.
  const result = spawnSync(python, ["-c", `
import json, sys, time
from pathlib import Path
from tmux_console.session_registry import SessionRegistry
from tmux_console.tmux import CreatedSession

registry = SessionRegistry(Path(sys.argv[1]))
try:
    identity = time.time_ns()
    records = [registry.record_created(CreatedSession(name, "$" + str(identity + index)), "/tmp")
               for index, name in enumerate(json.loads(sys.argv[2]))]
    print(json.dumps([record.to_dict() for record in records]))
finally:
    registry.close()
`, registryPath, JSON.stringify(names)], { encoding: "utf8" });
  expect(result.status, result.stderr).toBe(0);
  const records = JSON.parse(result.stdout) as RecoverableSession[];
  recoveryIds.push(...records.map((record) => record.id));
  return records;
}

async function createWorkspace(
  request: APIRequestContext,
  name: string,
  tabs: string[],
  grouped = false,
): Promise<SavedWorkspace> {
  const response = await request.post("/mux/api/workspaces", {
    data: {
      name,
      tabs,
      activeSession: tabs[0],
      groups: grouped ? [{
        id: "recovery-group", name: "Recovery group", color: "blue", collapsed: false, tabs,
      }] : [],
    },
  });
  expect(response.ok()).toBe(true);
  const workspace = (await response.json()).workspace as SavedWorkspace;
  workspaceIds.push(workspace.id);
  return workspace;
}

async function readWorkspace(request: APIRequestContext, id: string): Promise<SavedWorkspace> {
  const response = await request.get(`/mux/api/workspaces/${id}`);
  expect(response.ok()).toBe(true);
  return (await response.json()).workspace as SavedWorkspace;
}

async function openWorkspace(page: Page, workspace: SavedWorkspace): Promise<void> {
  const query = new URLSearchParams({ workspace: workspace.id });
  workspace.tabs.forEach((name) => query.append("tab", name));
  await page.goto(`/mux/session/${workspace.tabs[0]}?${query}`);
  await expect(page.locator(".workspace-saved-indicator.saved")).toHaveCount(1);
  await expect(page.locator(".workspace-tab[data-workspace-session-name]"))
    .toHaveCount(workspace.tabs.length);
}

test("dashboard Undo restores a forgotten recovery and its workspace placements in another tab", async ({
  page, context,
}) => {
  const records = seedRecoveries("dashboard-forget", 4);
  const [before, forgotten, after, orphan] = records;
  const tabs = [before.name, forgotten.name, after.name];
  const workspace = await createWorkspace(context.request, "Browser recovery primary", tabs, true);
  const otherWorkspace = await createWorkspace(
    context.request, "Browser recovery secondary", [forgotten.name],
  );
  const secondPage = await context.newPage();
  await openWorkspace(secondPage, workspace);
  await page.goto(`/mux/?workspace=${workspace.id}`);
  await expect(recoveryCard(page, forgotten.name).locator(".session-workspace-membership"))
    .toHaveAttribute("aria-label", "Workspaces: Browser recovery primary, Browser recovery secondary");
  await expect(recoveryCard(page, orphan.name).getByLabel("No workspace", { exact: true }))
    .toBeVisible();

  await page.getByRole("button", { name: `Forget recovery record for ${forgotten.name}`, exact: true })
    .click();
  await expect(recoveryCard(page, forgotten.name)).toHaveCount(0);
  await expect(tabRow(secondPage, forgotten.name)).toHaveCount(0);
  await expect(undoButton(page, forgotten.name)).toBeVisible();
  expect((await readWorkspace(context.request, workspace.id)).tabs).toEqual([before.name, after.name]);
  expect((await readWorkspace(context.request, otherWorkspace.id)).tabs).toEqual([]);

  await undoButton(page, forgotten.name).click();
  await expect(undoButton(page, forgotten.name)).toHaveCount(0);
  await expect(recoveryCard(page, forgotten.name)).toBeVisible();
  await expect(tabRow(secondPage, forgotten.name)).toHaveCount(1);
  await expect.poll(async () => (await readWorkspace(context.request, workspace.id)).tabs)
    .toEqual(tabs);
  expect((await readWorkspace(context.request, workspace.id)).groups).toEqual(workspace.groups);
  expect((await readWorkspace(context.request, otherWorkspace.id)).tabs).toEqual([forgotten.name]);
  await expect(tabRow(secondPage, before.name).getByRole("tab"))
    .toHaveAttribute("aria-selected", "true");

  await page.reload();
  await secondPage.reload();
  await expect(recoveryCard(page, forgotten.name)).toBeVisible();
  await expect(tabRow(secondPage, forgotten.name)).toHaveCount(1);
  const inventory = await context.request.get("/mux/api/sessions");
  expect((await inventory.json()).sessions).toEqual([]);
});

test("Undo after forgetting the active console restores its selection and recovery controls", async ({
  page, context,
}) => {
  const [forgotten, neighbor] = seedRecoveries("console-forget", 2);
  const workspace = await createWorkspace(
    context.request, "Browser console recovery", [forgotten.name, neighbor.name],
  );
  await openWorkspace(page, workspace);
  await page.getByRole("button", { name: `Forget recovery record for ${forgotten.name}`, exact: true })
    .click();
  await expect(tabRow(page, forgotten.name)).toHaveCount(0);
  await expect(tabRow(page, neighbor.name).getByRole("tab"))
    .toHaveAttribute("aria-selected", "true");
  await expect(undoButton(page, forgotten.name)).toBeVisible();

  await undoButton(page, forgotten.name).click();
  await expect(tabRow(page, forgotten.name).getByRole("tab"))
    .toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("button", { name: "Recreate shell", exact: true })).toBeEnabled();
  expect((await readWorkspace(context.request, workspace.id)).tabs)
    .toEqual([forgotten.name, neighbor.name]);
});

test("the floating Undo expires after 30 seconds and forgotten entries stay removed", async ({
  page, context,
}) => {
  const [forgotten] = seedRecoveries("expired-forget", 1);
  const workspace = await createWorkspace(
    context.request, "Browser expired recovery", [forgotten.name],
  );
  await page.clock.install();
  await page.goto(`/mux/?workspace=${workspace.id}`);
  await page.getByRole("button", { name: `Forget recovery record for ${forgotten.name}`, exact: true })
    .click();
  await expect(undoButton(page, forgotten.name)).toBeVisible();
  await page.clock.fastForward(29_000);
  await expect(undoButton(page, forgotten.name)).toBeVisible();
  await page.clock.fastForward(2_000);
  await expect(undoButton(page, forgotten.name)).toHaveCount(0);
  await page.reload();
  await expect(recoveryCard(page, forgotten.name)).toHaveCount(0);
  expect((await readWorkspace(context.request, workspace.id)).tabs).toEqual([]);
  const inventory = await context.request.get("/mux/api/sessions");
  expect((await inventory.json()).recoverableSessions).not.toEqual(expect.arrayContaining([
    expect.objectContaining({ id: forgotten.id }),
  ]));
});

test("live dashboard cards and mobile rows identify sessions without a workspace", async ({
  page, context,
}, testInfo) => {
  const names = ["membership-assigned", "membership-unassigned"];
  const sessions: Session[] = names.map((name, index) => ({
    name, id: `$${index}`, windows: 1, attached: 0, created: 1,
    serverStarted: 1, serverPid: 1, activity: 1, activePaneId: `%${index}`,
    agentState: "other", agentStateReason: "Shell", agentStateChangedAt: 1,
    customTitle: null, tags: [], starred: false, ignored: false, queuedMessageCount: 0,
    panes: [{
      id: `%${index}`, index: 0, window_index: 0, window_name: "main", window_active: true,
      active: true, command: "bash", path: "/tmp/browser-membership-fixture", title: "Shell",
      width: 100, height: 30, history_size: 0, history_limit: 2000, alternate_on: false,
      dead: false, activity: 1,
    }],
  }));
  const payload = JSON.stringify({ sessions, recoverableSessions: [] });
  await page.route("**/api/sessions", (route) => route.fulfill({
    contentType: "application/json", body: payload,
  }));
  await page.route("**/api/sessions/stream", (route) => route.fulfill({
    contentType: "text/event-stream", body: `event: sessions\ndata: ${payload}\n\n`,
  }));
  await createWorkspace(context.request, "Release review", [names[0]]);
  await page.goto("/mux/?kind=shells");
  const assigned = page.getByRole("button", { name: `Open ${names[0]}`, exact: true });
  const unassigned = page.getByRole("button", { name: `Open ${names[1]}`, exact: true });
  await expect(assigned.getByLabel("Workspace: Release review", { exact: true })).toBeVisible();
  await expect(unassigned.getByLabel("No workspace", { exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("workspace-membership-cards.png"), fullPage: true });

  await page.getByRole("button", { name: "List", exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(assigned.getByLabel("Workspace: Release review", { exact: true })).toBeVisible();
  await expect(unassigned.getByLabel("No workspace", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth))
    .toBeLessThanOrEqual(390);
  for (const card of [assigned, unassigned]) {
    const badge = await card.locator(".session-workspace-membership").boundingBox();
    const bounds = await card.boundingBox();
    expect(badge!.y).toBeGreaterThanOrEqual(bounds!.y);
    expect(badge!.y + badge!.height).toBeLessThanOrEqual(bounds!.y + bounds!.height + 1);
  }
  await page.screenshot({ path: testInfo.outputPath("workspace-membership-mobile-list.png"), fullPage: true });
});
