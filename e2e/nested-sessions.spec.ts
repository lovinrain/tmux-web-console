import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import type { SavedWorkspace } from "../src/api";
import { E2E_AUTH_PASSWORD, E2E_AUTH_USERNAME } from "./authFixture";

const socketName = process.env.MUXDECK_PLAYWRIGHT_TMUX_SOCKET;
if (!socketName?.startsWith("muxdeck-playwright-")) {
  throw new Error("Nested-session fixtures require the disposable Playwright tmux socket");
}
const tmux = ["-L", socketName];
const sourceName = `muxdeck-nested-${process.pid}`;
const workspaceIds: string[] = [];
const reviewDirectory = "/tmp/muxdeck-nested-sessions-review";
const tabRows = (page: Page) => page.locator(".workspace-tab[data-workspace-session-name]");
const tabRow = (page: Page, name: string) => page.locator(
  `.workspace-tab[data-workspace-session-name="${name}"]`,
);

test.use({ viewport: { width: 1440, height: 900 } });

test.beforeAll(() => {
  mkdirSync(reviewDirectory, { recursive: true });
  execFileSync("tmux", [
    ...tmux, "new-session", "-d", "-s", sourceName, "bash", "--noprofile", "--norc",
  ]);
  // Copy New uses the server's default command. Keep every copied fixture a
  // plain idle shell, with no startup files or terminal input.
  execFileSync("tmux", [...tmux, "set-option", "-g", "default-command", "bash --noprofile --norc"]);
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
  const names = execFileSync("tmux", [...tmux, "list-sessions", "-F", "#{session_name}"], {
    encoding: "utf8",
  }).trim().split("\n");
  // Exact names on the required isolated socket only; never touch live tmux.
  for (const name of names.filter((name) => name === sourceName || name.startsWith(`${sourceName}_`))) {
    execFileSync("tmux", [...tmux, "kill-session", "-t", `=${name}`]);
  }
});

async function readWorkspace(request: APIRequestContext, id: string): Promise<SavedWorkspace> {
  const response = await request.get(`/mux/api/workspaces/${id}`);
  expect(response.ok()).toBe(true);
  return (await response.json()).workspace as SavedWorkspace;
}

async function expectTree(
  page: Page,
  tabs: string[],
  parents: Record<string, string>,
): Promise<void> {
  await expect.poll(() => tabRows(page).evaluateAll((rows) => (
    rows.map((row) => row.getAttribute("data-workspace-session-name"))
  ))).toEqual(tabs);
  for (const name of tabs) {
    const row = tabRow(page, name);
    if (!parents[name]) {
      await expect(row).not.toHaveAttribute("data-session-parent");
      await expect(row).not.toHaveAttribute("data-session-depth");
      continue;
    }
    let depth = 0;
    for (let cursor = name; parents[cursor]; cursor = parents[cursor]) depth++;
    await expect(row).toHaveAttribute("data-session-parent", parents[name]);
    await expect(row).toHaveAttribute("data-session-depth", String(depth));
    await expect(row.getByRole("tab")).toHaveAttribute("aria-description", new RegExp(`Nesting level ${depth}`));
    await expect(row.locator(".workspace-tab-child-marker")).toBeVisible();
  }
}

async function selectTab(page: Page, name: string): Promise<void> {
  await tabRow(page, name).getByRole("tab").click();
  await expect(tabRow(page, name).getByRole("tab")).toHaveAttribute("aria-selected", "true");
  await expect(page.locator(".connection-badge")).toContainText("Live");
}

async function startTabDrag(page: Page, name: string): Promise<void> {
  const tab = tabRow(page, name).getByRole("tab");
  await tab.hover();
  await page.mouse.down();
  const box = (await tab.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 + 12, { steps: 5 });
  await expect(tabRow(page, name)).toHaveAttribute("data-tab-dragging", "true");
}

async function copySession(page: Page, parent: string, child: boolean): Promise<string> {
  await selectTab(page, parent);
  if (child && parent === sourceName) {
    await page.screenshot({ path: join(reviewDirectory, "copy-session-buttons.png") });
  }
  const responsePromise = page.waitForResponse((response) => (
    new URL(response.url()).pathname === `/mux/api/sessions/${parent}/copy`
      && response.request().method() === "POST"
  ));
  if (child) {
    await page.getByRole("button", { name: "Copy child session", exact: true }).click();
  } else {
    await page.getByRole("button", { name: "Copy sibling session", exact: true }).click();
  }
  const response = await responsePromise;
  expect(response.status()).toBe(201);
  const name = (await response.json()).session as string;
  expect(name.startsWith(`${sourceName}_`)).toBe(true);
  await expect(tabRow(page, name).getByRole("tab")).toHaveAttribute("aria-selected", "true");
  await expect(page.locator(".connection-badge")).toContainText("Live");
  return name;
}

function sessionIdentity(name: string): string {
  return execFileSync("tmux", [
    ...tmux, "list-panes", "-t", `=${name}`,
    "-F", "#{session_id}:#{pane_id}:#{pane_pid}:#{pane_dead}",
  ], { encoding: "utf8" }).trim();
}

test("copies preserve sibling or child placement through save, reload, and another browser tab", async ({
  page, context,
}) => {
  test.setTimeout(60_000);
  await page.goto(`/mux/session/${sourceName}?tab=${sourceName}`);
  const child = await copySession(page, sourceName, true);
  const grandchild = await copySession(page, child, true);
  const sibling = await copySession(page, child, false);
  let tabs = [sourceName, child, grandchild, sibling];
  let parents: Record<string, string> = {
    [child]: sourceName, [grandchild]: child, [sibling]: sourceName,
  };
  await expectTree(page, tabs, parents);
  expect(JSON.parse(new URL(page.url()).searchParams.get("tab-parent")!)).toEqual(parents);

  await page.reload();
  await expectTree(page, tabs, parents);
  await page.getByRole("button", { name: "Save workspace", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Save this workspace", exact: true });
  await dialog.getByLabel("Workspace name", { exact: true }).fill("Nested browser workspace");
  const savePromise = page.waitForResponse((response) => (
    new URL(response.url()).pathname === "/mux/api/workspaces"
      && response.request().method() === "POST"
  ));
  await dialog.getByRole("button", { name: "Save workspace", exact: true }).click();
  const saveResponse = await savePromise;
  expect(saveResponse.ok()).toBe(true);
  const workspace = (await saveResponse.json()).workspace as SavedWorkspace;
  workspaceIds.push(workspace.id);
  expect(workspace.parents).toEqual(parents);
  await expect(page.locator(".workspace-saved-indicator.saved")).toHaveCount(1);

  const second = await context.newPage();
  await second.goto(page.url());
  await expectTree(second, tabs, parents);
  await selectTab(second, grandchild);
  const syncedChild = await copySession(page, sibling, true);
  tabs = [...tabs, syncedChild];
  parents = { ...parents, [syncedChild]: sibling };
  await expectTree(page, tabs, parents);
  await expectTree(second, tabs, parents);
  const rootSibling = await copySession(page, sourceName, false);
  tabs = [...tabs, rootSibling];
  await expectTree(page, tabs, parents);
  await expectTree(second, tabs, parents);
  await expect(tabRow(second, grandchild).getByRole("tab")).toHaveAttribute("aria-selected", "true");
  await expect.poll(async () => (await readWorkspace(context.request, workspace.id)).parents)
    .toEqual(parents);
  // Live sessions have the full action set, including termination. The indent
  // must not let those controls squeeze every character out of a child's title.
  for (const name of Object.keys(parents)) {
    await expect.poll(async () => (
      (await tabRow(page, name).locator(".workspace-tab-title").boundingBox())?.width ?? 0
    )).toBeGreaterThanOrEqual(32);
  }
  await page.screenshot({ path: join(reviewDirectory, "nested-copies-saved.png") });

  const allSessions = [...tabs];
  const identities = allSessions.map(sessionIdentity);
  await tabRow(page, child).getByRole("button", { name: `Close ${child} quick tab`, exact: true }).click();
  tabs = tabs.filter((name) => name !== child);
  parents = { [grandchild]: sourceName, [sibling]: sourceName, [syncedChild]: sibling };
  await expectTree(page, tabs, parents);
  await expectTree(second, tabs, parents);
  await expect(tabRow(second, grandchild).getByRole("tab")).toHaveAttribute("aria-selected", "true");
  await tabRow(page, sourceName).getByRole("button", {
    name: `Close ${sourceName} quick tab`, exact: true,
  }).click();
  tabs = tabs.filter((name) => name !== sourceName);
  parents = { [syncedChild]: sibling };
  await expectTree(page, tabs, parents);
  await expectTree(second, tabs, parents);
  await expect.poll(async () => (await readWorkspace(context.request, workspace.id)).parents ?? {})
    .toEqual(parents);
  await second.reload();
  await expectTree(second, tabs, parents);
  expect(allSessions.map(sessionIdentity)).toEqual(identities);
});

test("nested tabs remain distinguishable in dark, light, and compact sidebars", async ({ page, context }) => {
  const tabs = ["missing-project", "missing-api", "missing-api-tests", "missing-web", "missing-standalone"];
  const parents = {
    "missing-api": "missing-project",
    "missing-api-tests": "missing-api",
    "missing-web": "missing-project",
  };
  const response = await context.request.post("/mux/api/workspaces", {
    data: { name: "Nested sidebar review", tabs, parents, activeSession: tabs[2], groups: [] },
  });
  expect(response.ok()).toBe(true);
  const workspace = (await response.json()).workspace as SavedWorkspace;
  workspaceIds.push(workspace.id);
  await page.goto(`/mux/session/${tabs[2]}?workspace=${workspace.id}`);
  await expectTree(page, tabs, parents);
  await page.evaluate(() => document.fonts.ready);
  const rowXs = await Promise.all(tabs.slice(0, 3).map(async (name) => (await tabRow(page, name).boundingBox())!.x));
  expect(rowXs[1]).toBeGreaterThan(rowXs[0]);
  expect(rowXs[2]).toBeGreaterThan(rowXs[1]);

  const navigation = page.locator(".workspace-navigation-vertical");
  const resize = page.getByRole("separator", { name: "Resize vertical session tabs", exact: true });
  for (const theme of ["dark", "light"]) {
    if (theme === "light") await page.getByRole("button", { name: "Light theme", exact: true }).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    await resize.press("Enter");
    await expect(navigation).not.toHaveAttribute("data-compact");
    await expectTree(page, tabs, parents);
    await page.screenshot({ path: join(reviewDirectory, `nested-sidebar-${theme}.png`) });
    await resize.press("Home");
    await expect(navigation).toHaveAttribute("data-compact", "true");
    await expectTree(page, tabs, parents);
    for (const name of Object.keys(parents)) {
      const row = tabRow(page, name);
      const rowBox = (await row.boundingBox())!;
      const markerBox = (await row.locator(".workspace-tab-child-marker").boundingBox())!;
      expect(markerBox.x).toBeGreaterThanOrEqual(rowBox.x);
      expect(markerBox.x + markerBox.width).toBeLessThanOrEqual(rowBox.x + rowBox.width);
    }
    await page.screenshot({ path: join(reviewDirectory, `nested-sidebar-${theme}-compact.png`) });
  }
});

test("existing branches move through the placement button, drag to nest, and transfer across workspaces", async ({ page, context }) => {
  test.setTimeout(60_000);
  const branch = `${sourceName}_ux-branch`;
  const child = `${sourceName}_ux-child`;
  const target = `${sourceName}_ux-target`;
  const destinationRoot = `${sourceName}_ux-destination`;
  const destinationParent = `${sourceName}_ux-parent`;
  const names = [sourceName, branch, child, target, destinationRoot, destinationParent];
  for (const name of names.slice(1)) {
    execFileSync("tmux", [...tmux, "new-session", "-d", "-s", name, "bash", "--noprofile", "--norc"]);
  }
  const identities = names.map(sessionIdentity);
  for (const [session, title] of [[sourceName, "Product"], [branch, "API implementation"], [child, "API tests"],
    [target, "Web application"], [destinationRoot, "Release"], [destinationParent, "Review queue"]]) {
    expect((await context.request.put("/mux/api/session-title", { data: { session, title } })).ok()).toBe(true);
  }
  const create = async (name: string, tabs: string[], parents: Record<string, string>) => {
    const response = await context.request.post("/mux/api/workspaces", { data: { name, tabs, parents, activeSession: tabs[0] } });
    expect(response.ok()).toBe(true);
    const workspace = (await response.json()).workspace as SavedWorkspace;
    workspaceIds.push(workspace.id);
    return workspace;
  };
  const source = await create("Product development", names.slice(0, 4), { [branch]: sourceName, [child]: branch });
  const destination = await create("Release review", names.slice(4), { [destinationParent]: destinationRoot });
  await page.goto(`/mux/session/${branch}?workspace=${source.id}`);
  await expectTree(page, source.tabs, source.parents!);
  const second = await context.newPage();
  await second.goto(`/mux/session/${sourceName}?workspace=${source.id}`);
  await expectTree(second, source.tabs, source.parents!);

  await selectTab(page, branch);
  const tabActions = page.getByRole("button", { name: "Tab action buttons", exact: true });
  await tabActions.click();
  await expect(tabActions).toHaveAttribute("aria-pressed", "false");
  const placementButton = page.getByRole("button", { name: "Move / Nest", exact: true });
  await expect(placementButton).toBeVisible();
  await placementButton.click();
  let dialog = page.getByRole("dialog", { name: "Move / Nest", exact: true });
  await expect(dialog.locator(".session-placement-source > strong")).toHaveText("API implementation");
  await expect(dialog.getByRole("searchbox", { name: "Find a parent session" })).toBeFocused();
  await expect(dialog.getByRole("radio", { name: "Nest under API tests", exact: true })).toHaveCount(0);
  await page.screenshot({ path: join(reviewDirectory, "placement-button-dialog.png") });
  await dialog.getByRole("button", { name: "Up one level", exact: true }).click();
  await expectTree(page, source.tabs, { [child]: branch });
  await expectTree(second, source.tabs, { [child]: branch });
  await expect(placementButton).toBeFocused();

  // Reveal the complete target before dragging so auto-scroll cannot
  // move its nesting zone out from under the pointer just before the drop.
  await tabRow(page, target).scrollIntoViewIfNeeded();
  await startTabDrag(page, branch);
  const targetTab = tabRow(page, target).getByRole("tab");
  await targetTab.hover();
  const targetBox = (await targetTab.boundingBox())!;
  // Chromium needs a move inside the target after dragenter to dispatch dragover.
  await page.mouse.move(targetBox.x + targetBox.width / 2 + 1, targetBox.y + targetBox.height / 2);
  await expect(tabRow(page, target)).toHaveAttribute("data-tab-drop-nest", "true");
  await page.mouse.up();
  const nestedTabs = [sourceName, target, branch, child];
  await expectTree(page, nestedTabs, { [branch]: target, [child]: branch });
  await expectTree(second, nestedTabs, { [branch]: target, [child]: branch });
  await expect(tabRow(second, sourceName).getByRole("tab")).toHaveAttribute("aria-selected", "true");

  await page.getByRole("button", { name: "Show callback list", exact: true }).click();
  await page.getByRole("button", { name: "Pin callback list", exact: true }).click();
  await page.getByRole("button", { name: "Vertical session tabs", exact: true }).click();
  await expect(page.locator("#muxdeck-session-tabs")).toHaveAttribute("data-orientation", "horizontal");
  await page.screenshot({ path: join(reviewDirectory, "placement-button-top-tabs.png") });
  await placementButton.click();
  dialog = page.getByRole("dialog", { name: "Move / Nest", exact: true });
  await expect(dialog.getByRole("radio", { name: "Nest under API tests", exact: true })).toHaveCount(0);
  await dialog.getByRole("combobox", { name: "Destination workspace" }).selectOption(destination.id);
  await dialog.getByRole("searchbox", { name: "Find a parent session" }).fill("Review queue");
  await dialog.getByRole("radio", { name: "Nest under Review queue", exact: true }).check();
  await page.screenshot({ path: join(reviewDirectory, "move-nest-across-workspaces.png") });
  await page.evaluate(() => window.dispatchEvent(new Event("muxdeck:toggle-theme")));
  await page.screenshot({ path: join(reviewDirectory, "move-nest-across-workspaces-light.png") });
  await page.evaluate(() => window.dispatchEvent(new Event("muxdeck:toggle-theme")));
  await dialog.getByRole("button", { name: "Move here", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expectTree(page, [sourceName, target], {});
  await expectTree(second, [sourceName, target], {});
  await page.getByRole("button", { name: "Close callback list", exact: true }).click();

  const destinationTabs = [destinationRoot, destinationParent, branch, child];
  await page.goto(`/mux/session/${branch}?workspace=${destination.id}`);
  await expectTree(page, destinationTabs, { [destinationParent]: destinationRoot, [branch]: destinationParent, [child]: branch });
  await startTabDrag(page, branch);
  const rootDrop = page.getByRole("group", { name: "Top level drop target", exact: true });
  await expect(rootDrop).toBeVisible();
  await rootDrop.hover();
  await page.mouse.up();
  await expectTree(page, destinationTabs, { [destinationParent]: destinationRoot, [child]: branch });
  await expect.poll(async () => (await readWorkspace(context.request, destination.id)).parents)
    .toEqual({ [destinationParent]: destinationRoot, [child]: branch });
  await page.reload();
  await expectTree(page, destinationTabs, { [destinationParent]: destinationRoot, [child]: branch });
  const footer = page.locator(".workspace-callback-footnote");
  await expect(footer).toBeVisible();
  await expect(footer).toContainText("Global 0/0");
  await expect(footer).toContainText("Local 0/0");
  const footerBox = (await footer.boundingBox())!;
  const consoleBox = (await page.locator(".console-shell").boundingBox())!;
  expect(consoleBox.y + consoleBox.height).toBeLessThanOrEqual(footerBox.y + 1);
  await page.screenshot({ path: join(reviewDirectory, "session-placement-footer-dark.png") });
  await page.evaluate(() => window.dispatchEvent(new Event("muxdeck:toggle-theme")));
  await page.screenshot({ path: join(reviewDirectory, "session-placement-footer-light.png") });
  expect(names.map(sessionIdentity)).toEqual(identities);
});
