import { execFileSync } from "node:child_process";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import type { SavedWorkspace } from "../src/api";
import { E2E_AUTH_PASSWORD, E2E_AUTH_USERNAME } from "./authFixture";

const socketName = process.env.MUXDECK_PLAYWRIGHT_TMUX_SOCKET;
if (!socketName) throw new Error("Playwright disposable tmux socket was not configured");
const tmux = ["-L", socketName];
const sessionNames = [`muxdeck-ephemeral-${process.pid}`, `muxdeck-ephemeral-${process.pid}-other`];
const workspaceIds: string[] = [];
const workspaceRequestPath = /\/api\/(?:workspaces|workspace-quick-links)(?:\/|$)/;

test.use({ viewport: { width: 1440, height: 900 } });

function sessionIdentity(name: string): string {
  return execFileSync("tmux", [
    ...tmux, "list-panes", "-t", `=${name}`,
    "-F", "#{session_name}=#{session_id}:#{pane_id}:#{pane_pid}:#{pane_dead}",
  ], { encoding: "utf8" }).trim();
}

function allSessionIdentities(): string[] {
  return execFileSync("tmux", [
    ...tmux, "list-sessions", "-F", "#{session_name}=#{session_id}",
  ], { encoding: "utf8" }).trim().split("\n").sort();
}

function sessionOutput(name: string): string {
  const paneId = execFileSync("tmux", [
    ...tmux, "list-panes", "-t", `=${name}`, "-F", "#{pane_id}",
  ], { encoding: "utf8" }).trim();
  return execFileSync("tmux", [
    ...tmux, "capture-pane", "-p", "-S", "-", "-t", paneId,
  ], { encoding: "utf8" });
}

async function createWorkspace(request: APIRequestContext): Promise<SavedWorkspace> {
  const response = await request.post("/mux/api/workspaces", {
    data: {
      name: "Ephemeral source",
      tabs: sessionNames,
      activeSession: sessionNames[0],
      groups: [{
        id: "ephemeral_source", name: "Source group", color: "cyan",
        collapsed: false, tabs: sessionNames,
      }],
    },
  });
  expect(response.ok()).toBe(true);
  const workspace = (await response.json()).workspace as SavedWorkspace;
  workspaceIds.push(workspace.id);
  return workspace;
}

async function expectSessionOnly(page: Page): Promise<void> {
  await expect(page.locator(".connection-badge")).toContainText("Live");
  await expect(page.locator(".workspace-tab")).toHaveCount(0);
  await expect(page.locator(".workspace-saved-indicator")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Save workspace", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Vertical session tabs", exact: true })).toHaveCount(0);
  await expect(page.locator(".split-workspace-button")).toHaveCount(0);
}

test.beforeAll(() => {
  for (const name of sessionNames) {
    execFileSync("tmux", [
      ...tmux, "new-session", "-d", "-s", name, "bash", "--noprofile", "--norc",
    ]);
  }
});

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
    const response = await context.request.delete(`/mux/api/workspaces/${id}`);
    expect(response.ok()).toBe(true);
  }
});

test.afterAll(() => {
  for (const name of sessionNames) {
    try {
      execFileSync("tmux", [...tmux, "kill-session", "-t", `=${name}`], { stdio: "ignore" });
    } catch {
      // Cleanup is restricted to this test's exact names on its disposable socket.
    }
  }
});

test("split to ephemeral tab shares only the active session and never saves workspace activity", async ({
  page, context,
}, testInfo) => {
  const workspace = await createWorkspace(context.request);
  const query = new URLSearchParams({ workspace: workspace.id });
  workspace.tabs.forEach((name) => query.append("tab", name));
  await page.goto(`/mux/session/${sessionNames[0]}?${query}`);
  await expect(page.locator(".connection-badge")).toContainText("Live");
  await expect(page.locator(".workspace-tab")).toHaveCount(2);
  await expect(page.locator(".workspace-saved-indicator.saved")).toHaveCount(1);
  const sourceUrl = page.url();
  const sourceIdentities = sessionNames.map(sessionIdentity);
  const sourceSessions = allSessionIdentities();
  const childWorkspaceRequests: string[] = [];
  context.on("request", (request) => {
    if (!workspaceRequestPath.test(new URL(request.url()).pathname)) return;
    if (request.frame().page() !== page) {
      childWorkspaceRequests.push(`${request.method()} ${new URL(request.url()).pathname}`);
    }
  });

  const [child] = await Promise.all([
    context.waitForEvent("page"),
    page.getByRole("button", { name: "Split to ephemeral tab", exact: true }).click(),
  ]);
  await expect(child).toHaveURL(`/mux/session/${sessionNames[0]}?ephemeral=1`);
  expect(await child.evaluate(() => window.opener === null)).toBe(true);
  await expectSessionOnly(child);
  await child.screenshot({ path: testInfo.outputPath("ephemeral-session.png"), fullPage: true });
  expect(childWorkspaceRequests).toEqual([]);
  await expect(page).toHaveURL(sourceUrl);
  expect(sessionNames.map(sessionIdentity)).toEqual(sourceIdentities);
  expect(allSessionIdentities()).toEqual(sourceSessions);

  await child.getByRole("textbox", { name: "Staged input" })
    .fill("printf 'EPHEMERAL_%s\\n' 'INPUT_OK'");
  await child.getByRole("button", { name: "Send + Enter", exact: true }).click();
  await expect.poll(() => sessionOutput(sessionNames[0])).toContain("EPHEMERAL_INPUT_OK");
  expect(sessionOutput(sessionNames[1])).not.toContain("EPHEMERAL_INPUT_OK");

  await child.reload();
  await expectSessionOnly(child);
  await expect(child).toHaveURL(`/mux/session/${sessionNames[0]}?ephemeral=1`);
  await child.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pagehide")));
  await Promise.all([
    child.waitForEvent("close"),
    child.getByRole("button", { name: "Close tab", exact: true }).click(),
  ]);
  await expect(page.locator(".workspace-tab")).toHaveCount(2);
  await expect(page).toHaveURL(sourceUrl);
  const response = await context.request.get(`/mux/api/workspaces/${workspace.id}`);
  expect(response.ok()).toBe(true);
  const saved = (await response.json()).workspace as SavedWorkspace;
  expect(saved.tabs).toEqual(workspace.tabs);
  expect(saved.groups).toEqual(workspace.groups);
  expect(saved.activeSession).toBe(sessionNames[0]);
  expect(sessionNames.map(sessionIdentity)).toEqual(sourceIdentities);
  expect(allSessionIdentities()).toEqual(sourceSessions);
  expect(childWorkspaceRequests).toEqual([]);
});

test("an ephemeral deep link discards inherited workspace parameters before loading or saving", async ({
  page, context,
}) => {
  const workspace = await createWorkspace(context.request);
  const workspaceRequests: string[] = [];
  page.on("request", (request) => {
    const pathname = new URL(request.url()).pathname;
    if (workspaceRequestPath.test(pathname)) workspaceRequests.push(`${request.method()} ${pathname}`);
  });
  const query = new URLSearchParams({
    ephemeral: "1",
    workspace: workspace.id,
    tab: sessionNames[0],
    "tab-group": JSON.stringify(workspace.groups?.[0]),
  });
  await page.goto(`/mux/session/${sessionNames[1]}?${query}`);
  await expectSessionOnly(page);
  await expect(page).toHaveURL(`/mux/session/${sessionNames[1]}?ephemeral=1`);
  await page.reload();
  await expectSessionOnly(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator(".workspace-tab")).toHaveCount(0);
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pagehide")));
  await page.close();
  expect(workspaceRequests).toEqual([]);
  const response = await context.request.get(`/mux/api/workspaces/${workspace.id}`);
  expect(response.ok()).toBe(true);
  expect((await response.json()).workspace).toEqual(workspace);
});
