import { execFileSync, spawnSync } from "node:child_process";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import type { SavedWorkspace } from "../src/api";
import type { Session } from "../src/types";
import { E2E_AUTH_PASSWORD, E2E_AUTH_USERNAME } from "./authFixture";

const socket = process.env.MUXDECK_PLAYWRIGHT_TMUX_SOCKET;
if (!socket?.startsWith("muxdeck-playwright-")) throw new Error("Tab fold tests require an isolated tmux socket");
const tmux = ["-L", socket];
const names = ["root", "a", "child", "gap", "b", "other"].map((name) => `fold-${process.pid}-${name}`);
const [root, a, child, gap, b, other] = names;
const workspaceIds: string[] = [];
const row = (page: Page, name: string) => page.locator(`[data-workspace-session-name="${name}"]`);
const visibleNames = (page: Page) => page.locator(".workspace-tab[data-workspace-session-name]")
  .evaluateAll((rows) => rows.map((element) => element.getAttribute("data-workspace-session-name")));

function identities() {
  return execFileSync("tmux", [...tmux, "list-panes", "-a", "-F", "#{session_name}:#{session_id}:#{pane_id}:#{pane_pid}:#{pane_dead}"],
    { encoding: "utf8" }).trim().split("\n").filter((line) => names.some((name) => line.startsWith(`${name}:`))).sort();
}

async function login(context: BrowserContext) {
  expect((await context.request.post("/mux/api/auth/login", {
    data: { username: E2E_AUTH_USERNAME, password: E2E_AUTH_PASSWORD },
  })).ok()).toBe(true);
  await context.addInitScript(() => {
    localStorage.setItem("muxdeck-desktop-tab-orientation", "vertical");
    localStorage.setItem("muxdeck-theme", "light");
  });
}

async function selectForFold(page: Page, selected: string[]) {
  await page.getByRole("button", { name: "Select tabs to fold", exact: true }).click();
  for (const name of selected) await row(page, name).getByRole("tab").click();
  await page.getByRole("button", { name: "Fold selected tabs", exact: true }).click();
}

test.use({ viewport: { width: 1440, height: 950 } });
test.beforeAll(() => {
  for (const name of names) execFileSync("tmux", [...tmux, "new-session", "-d", "-s", name, "bash", "--noprofile", "--norc"]);
});
test.beforeEach(async ({ context }) => login(context));
test.afterEach(async ({ context }) => {
  await Promise.all(context.pages().map((page) => page.close()));
  for (const id of workspaceIds.splice(0)) expect((await context.request.delete(`/mux/api/workspaces/${id}`)).ok()).toBe(true);
});
test.afterAll(() => {
  for (const name of names) execFileSync("tmux", [...tmux, "kill-session", "-t", `=${name}`]);
});

test("nonadjacent folds preserve the active terminal and survive URL reload and saving", async ({ page, context }) => {
  const before = identities();
  const tabs = [a, gap, b];
  const query = new URLSearchParams();
  tabs.forEach((name) => query.append("tab", name));
  await page.goto(`/mux/session/${a}?${query}`);
  await expect(row(page, a).getByRole("tab")).toHaveAttribute("aria-selected", "true");
  await selectForFold(page, [a, b]);
  await expect(page.getByRole("tab", { name: "Preview fold of 2 sessions", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect.poll(async () => (await page.locator(".workspace-fold-placeholder svg").first().boundingBox())?.width ?? 0).toBeLessThanOrEqual(20);
  await expect.poll(() => visibleNames(page)).toEqual([gap]);
  await page.getByRole("tab", { name: "Preview fold of 2 sessions", exact: true }).click();
  const preview = page.getByRole("dialog", { name: "Fold preview", exact: true });
  await preview.getByRole("button", { name: `Preview ${b}`, exact: true }).click();
  await expect(preview).toBeHidden();
  expect(new URL(page.url()).pathname).toBe(`/mux/session/${b}`);
  await expect(page.getByRole("tab", { name: "Preview fold of 2 sessions", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect.poll(() => visibleNames(page)).toEqual([gap]);
  await page.getByRole("tab", { name: "Preview fold of 2 sessions", exact: true }).click();
  await preview.getByRole("button", { name: `Preview ${a}`, exact: true }).click();
  expect(new URL(page.url()).pathname).toBe(`/mux/session/${a}`);
  expect(new URL(page.url()).searchParams.getAll("tab")).toEqual(tabs);
  await page.reload();
  await expect(page.getByRole("tab", { name: "Preview fold of 2 sessions", exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Save workspace", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Save this workspace", exact: true });
  await dialog.getByLabel("Workspace name", { exact: true }).fill("Fold browser save");
  const saving = page.waitForResponse((response) => response.request().method() === "POST" && new URL(response.url()).pathname === "/mux/api/workspaces");
  await dialog.getByRole("button", { name: "Save workspace", exact: true }).click();
  const workspace = (await (await saving).json()).workspace as SavedWorkspace;
  workspaceIds.push(workspace.id);
  expect(workspace.folds?.[0].tabs).toEqual([a, b]);
  await expect(page.locator(".workspace-saved-indicator.saved")).toHaveCount(1);
  await page.reload();
  await expect(page.getByRole("tab", { name: "Preview fold of 2 sessions", exact: true })).toHaveAttribute("aria-selected", "true");
  await page.screenshot({ path: test.info().outputPath("fold-saved-light.png") });
  await page.getByRole("button", { name: "Unfold 2 sessions", exact: true }).click();
  await expect.poll(() => visibleNames(page)).toEqual(tabs);
  await expect(row(page, a).getByRole("tab")).toHaveAttribute("aria-selected", "true");
  await page.getByRole("button", { name: "Vertical session tabs", exact: true }).click();
  await expect(page.locator(".workspace-navigation-horizontal")).toBeVisible();
  await selectForFold(page, [a, b]);
  await expect(page.getByRole("tab", { name: "Preview fold of 2 sessions", exact: true })).toBeVisible();
  await expect.poll(async () => (await page.locator(".workspace-fold-placeholder svg").first().boundingBox())?.width ?? 0).toBeLessThanOrEqual(20);
  await page.screenshot({ path: test.info().outputPath("fold-top-tabs-light.png") });
  expect(identities()).toEqual(before);
});

test("fold-and-close preserves a saved nested tree and recovers shells from its preview", async ({ page, context }) => {
  const original = identities();
  const parents = { [a]: root, [child]: a, [gap]: root, [b]: root };
  const response = await context.request.post("/mux/api/workspaces", { data: {
    name: "Closed folds", tabs: names, activeSession: a, parents,
  } });
  expect(response.ok()).toBe(true);
  const workspace = (await response.json()).workspace as SavedWorkspace;
  workspaceIds.push(workspace.id);
  await page.goto(`/mux/session/${a}?workspace=${workspace.id}`);
  await expect(row(page, a).getByRole("tab")).toHaveAttribute("aria-selected", "true");
  await page.getByRole("button", { name: "Select tabs to fold", exact: true }).click();
  for (const name of [a, b]) await row(page, name).getByRole("tab").click();
  await page.getByRole("button", { name: "Fold and close selected sessions", exact: true }).click();
  const confirm = page.getByRole("alertdialog", { name: "Fold and close 3 sessions?", exact: true });
  await expect(confirm).toContainText(child);
  await confirm.getByRole("button", { name: "Fold and close", exact: true }).click();
  await expect(confirm).toBeHidden();
  await expect(page.getByRole("tab", { name: "Preview fold of 3 sessions", exact: true })).toContainText("Saved fold");
  const persisted = (await (await context.request.get(`/mux/api/workspaces/${workspace.id}`)).json()).workspace as SavedWorkspace;
  expect(persisted.parents).toEqual(parents);
  expect(persisted.tabs).toEqual(names);
  expect(persisted.folds?.[0].closedSessions?.map((item) => item.name)).toEqual([a, child, b]);
  expect(identities()).toEqual(original.filter((line) => ![a, child, b].some((name) => line.startsWith(`${name}:`))));
  await page.reload();
  await page.getByRole("tab", { name: "Preview fold of 3 sessions", exact: true }).click();
  const preview = page.getByRole("dialog", { name: "Fold preview", exact: true });
  await expect(preview).toContainText("0 running");
  await page.screenshot({ path: test.info().outputPath("fold-preview-closed-light.png") });
  await preview.getByRole("button", { name: `Recover shell for ${a}`, exact: true }).click();
  await expect(preview.getByRole("button", { name: `Preview ${a}`, exact: true })).toBeVisible();
  await preview.getByRole("button", { name: `Preview ${a}`, exact: true }).click();
  await expect(page.getByRole("tab", { name: "Preview fold of 3 sessions", exact: true })).toHaveAttribute("aria-selected", "true");
  await page.getByRole("tab", { name: "Preview fold of 3 sessions", exact: true }).click();
  await preview.getByRole("button", { name: "Recover all shells", exact: true }).click();
  await expect(preview).toContainText("3 running");
  await preview.getByRole("button", { name: "Unfold", exact: true }).click();
  await expect.poll(() => visibleNames(page)).toEqual(names);
  await expect(row(page, a).getByRole("tab")).toHaveAttribute("aria-selected", "true");
  expect(identities().filter((line) => [root, gap, other].some((name) => line.startsWith(`${name}:`))))
    .toEqual(original.filter((line) => [root, gap, other].some((name) => line.startsWith(`${name}:`))));
});

test("nested folds sync across browser profiles while keeping each selected session", async ({ page, context, browser }) => {
  const before = identities();
  const parents = { [a]: root, [child]: a, [gap]: root, [b]: root };
  const response = await context.request.post("/mux/api/workspaces", { data: {
    name: "Nested folds", tabs: names, activeSession: child, parents,
    groups: [{ id: "family", name: "Family", color: "blue", collapsed: false, tabs: names.slice(0, 5) }],
  } });
  expect(response.ok()).toBe(true);
  const workspace = (await response.json()).workspace as SavedWorkspace;
  workspaceIds.push(workspace.id);
  const secondContext = await browser.newContext({ viewport: { width: 1440, height: 950 } });
  try {
    await login(secondContext);
    const second = await secondContext.newPage();
    await page.goto(`/mux/session/${child}?workspace=${workspace.id}`);
    await second.goto(`/mux/session/${other}?workspace=${workspace.id}`);
    await expect(row(page, child).getByRole("tab")).toHaveAttribute("aria-selected", "true");
    await row(second, other).getByRole("tab").click();
    await selectForFold(page, [a, b]);
    for (const view of [page, second]) {
      await expect(view.getByRole("tab", { name: "Preview fold of 3 sessions", exact: true })).toBeVisible();
      await expect.poll(() => visibleNames(view)).toEqual([root, gap, other]);
      await expect(view.locator("[data-workspace-tab-fold-id]")).toHaveAttribute("data-session-depth", "1");
    }
    await expect(second.getByRole("tab", { name: "Preview fold of 3 sessions", exact: true })).toHaveAttribute("aria-selected", "false");
    await expect(row(second, other).getByRole("tab")).toHaveAttribute("aria-selected", "true");
    await second.reload();
    await expect(second.getByRole("tab", { name: "Preview fold of 3 sessions", exact: true })).toBeVisible();
    // Reload restores the workspace's saved active session. Establish the
    // independent selection again before checking the live unfold stream.
    await row(second, other).getByRole("tab").click();
    await expect(row(second, other).getByRole("tab")).toHaveAttribute("aria-selected", "true");
    await page.screenshot({ path: test.info().outputPath("fold-nested-light.png") });
    await second.getByRole("button", { name: "Unfold 3 sessions", exact: true }).click();
    for (const view of [page, second]) await expect.poll(() => visibleNames(view)).toEqual(names);
    await expect(row(page, child).getByRole("tab")).toHaveAttribute("aria-selected", "true");
    await expect(row(second, other).getByRole("tab")).toHaveAttribute("aria-selected", "true");
    const persisted = (await (await context.request.get(`/mux/api/workspaces/${workspace.id}`)).json()).workspace as SavedWorkspace;
    expect(persisted.parents).toEqual(parents);
    expect(persisted.groups).toEqual(workspace.groups);
    expect(persisted.folds ?? []).toEqual([]);
    expect(identities()).toEqual(before);
  } finally {
    await secondContext.close();
  }
});

for (const contents of ["mixed", "closed"] as const) {
  test(`deleting a ${contents} saved fold preserves history and syncs without recovering closed sessions`, async ({ page, context }) => {
    const targets = ["a", "b", "c"].map((name) => `fold-delete-${process.pid}-${contents}-${name}`);
    const sentinel = `fold-delete-${process.pid}-${contents}-sentinel`;
    const ownNames = [...targets, sentinel];
    for (const name of ownNames) execFileSync("tmux", [...tmux, "new-session", "-d", "-s", name, "bash", "--noprofile", "--norc"]);
    try {
      const response = await context.request.post("/mux/api/workspaces", { data: {
        name: `Delete ${contents} fold`, tabs: ownNames, activeSession: targets[0], folds: [{ id: "delete", tabs: targets }],
      } });
      expect(response.ok()).toBe(true);
      let workspace = (await response.json()).workspace as SavedWorkspace;
      workspaceIds.push(workspace.id);
      const inventory = (await (await context.request.get("/mux/api/sessions")).json()).sessions as Session[];
      const sessions = targets.map((name) => {
        const current = inventory.find((session) => session.name === name)!;
        return { name, sessionId: current.id, sessionCreated: current.created,
          serverStarted: current.serverStarted, serverPid: current.serverPid };
      });
      const closing = await context.request.post(`/mux/api/workspaces/${workspace.id}/folds/delete/close`, { data: {
        tabs: targets, sessions, sessionRevision: workspace.sessionRevision, expectedUpdatedAt: workspace.updatedAt,
      } });
      expect(closing.ok()).toBe(true);
      workspace = (await closing.json()).workspace as SavedWorkspace;
      const archivedIds = workspace.folds![0].closedSessions!.map((snapshot) => snapshot.historyId);
      if (contents === "mixed") {
        for (const name of targets.slice(0, 2)) expect((await context.request.post(
          `/mux/api/workspaces/${workspace.id}/folds/delete/recover`, { data: { session: name, mode: "shell" } },
        )).ok()).toBe(true);
        const recovered = (await (await context.request.get("/mux/api/sessions")).json()).sessions as Session[];
        const deadPane = recovered.find((session) => session.name === targets[1])!.panes[0].id;
        execFileSync("tmux", [...tmux, "set-option", "-w", "-t", deadPane, "remain-on-exit", "on"]);
        execFileSync("tmux", [...tmux, "respawn-pane", "-k", "-t", deadPane, "true"]);
      }
      const unexpectedRecoveries: string[] = [];
      context.on("request", (request) => {
        if (new URL(request.url()).pathname.endsWith("/recover")) unexpectedRecoveries.push(request.url());
      });
      const second = await context.newPage();
      await page.goto(`/mux/session/${targets[0]}?workspace=${workspace.id}`);
      await second.goto(`/mux/session/${sentinel}?workspace=${workspace.id}`);
      const fold = page.getByRole("tab", { name: "Preview fold of 3 sessions", exact: true });
      await fold.click();
      const preview = page.getByRole("dialog", { name: "Fold preview", exact: true });
      await expect(preview).toContainText(contents === "mixed" ? "1 running · 1 dead" : "0 running");
      await preview.getByRole("button", { name: "Delete fold", exact: true }).click();
      const confirm = page.getByRole("alertdialog", { name: "Delete fold and 3 tabs?", exact: true });
      await expect(confirm).toContainText("remain available in History");
      await confirm.getByRole("button", { name: "Cancel", exact: true }).click();
      await expect(fold).toBeVisible();
      await fold.click();
      await preview.getByRole("button", { name: "Delete fold", exact: true }).click();
      await page.screenshot({ path: test.info().outputPath(`delete-${contents}-confirmation-light.png`) });
      await confirm.getByRole("button", { name: contents === "mixed" ? "Archive and delete" : "Delete fold", exact: true }).click();
      await expect(confirm).toBeHidden();
      for (const view of [page, second]) {
        await expect(view.getByRole("tab", { name: "Preview fold of 3 sessions", exact: true })).toHaveCount(0);
        await expect.poll(() => visibleNames(view)).toEqual([sentinel]);
        await view.reload();
        await expect.poll(() => visibleNames(view)).toEqual([sentinel]);
      }
      expect(unexpectedRecoveries).toEqual([]);
      const history = (await (await context.request.get(`/mux/api/session-history?workspace=${workspace.id}&recycled=1`)).json()).entries;
      expect(history.map((item: { id: string }) => item.id)).toEqual(expect.arrayContaining(archivedIds));
      for (const name of targets) expect(spawnSync("tmux", [...tmux, "has-session", "-t", `=${name}`]).status).not.toBe(0);
      expect(spawnSync("tmux", [...tmux, "has-session", "-t", `=${sentinel}`]).status).toBe(0);
    } finally {
      for (const name of ownNames) spawnSync("tmux", [...tmux, "kill-session", "-t", `=${name}`]);
    }
  });
}
