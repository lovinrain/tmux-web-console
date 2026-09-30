import { expect, test, type BrowserContext, type Locator, type Page } from "@playwright/test";
import type { GlobalCallbackSnapshot, SavedWorkspace } from "../src/api";
import { E2E_AUTH_PASSWORD, E2E_AUTH_USERNAME } from "./authFixture";

test.use({ viewport: { width: 1440, height: 1000 } });

async function login(context: BrowserContext): Promise<void> {
  if (!process.env.MUXDECK_PLAYWRIGHT_AUTH_FILE?.startsWith("/tmp/muxdeck-playwright-")) {
    throw new Error("Custom group fixtures require disposable Playwright authentication");
  }
  expect((await context.request.post("/mux/api/auth/login", {
    data: { username: E2E_AUTH_USERNAME, password: E2E_AUTH_PASSWORD },
  })).ok()).toBe(true);
}

async function openPanel(page: Page, workspace: SavedWorkspace): Promise<Locator> {
  // Groups and streams use the real isolated server. Session discovery is a
  // fixture so no terminal connection or running agent is involved.
  const sessions = { sessions: [], recoverableSessions: [] };
  await page.route("**/mux/api/sessions", (route) => route.fulfill({ json: sessions }));
  await page.route("**/mux/api/sessions/stream", (route) => route.fulfill({
    contentType: "text/event-stream", body: `event: sessions\ndata: ${JSON.stringify(sessions)}\n\n`,
  }));
  await page.goto(`/mux/?workspace=${workspace.id}`);
  await expect(page.locator(".dashboard-shell")).toBeVisible();
  const show = page.getByRole("button", { name: "Show callback list", exact: true });
  if (await show.count()) await show.click();
  const panel = page.getByRole("dialog", { name: "Callback list", exact: true });
  await expect(panel).toBeVisible();
  await panel.getByRole("button", { name: "Workspace callback scope" }).click();
  await panel.getByRole("combobox", { name: "Group callbacks by" }).selectOption("custom");
  await expect(panel.getByRole("button", { name: "New group", exact: true })).toBeEnabled();
  return panel;
}

test("custom callback groups sync across browser profiles, handle concurrent edits, and keep callbacks after deletion", async ({
  page, context, browser, baseURL,
}, testInfo) => {
  test.setTimeout(60_000);
  await login(context);
  const names = ["frontend-review", "api-review", "tests-review"];
  const created = await context.request.post("/mux/api/workspaces", {
    data: { name: "Custom callback groups review", tabs: names, callbackSessions: names, activeSession: names[0] },
  });
  expect(created.status()).toBe(201);
  const workspace = (await created.json()).workspace as SavedWorkspace;
  const secondContext = await browser.newContext({ baseURL, viewport: { width: 1440, height: 1000 } });
  try {
    await login(secondContext);
    const secondPage = await secondContext.newPage();
    const panel = await openPanel(page, workspace);
    const peer = await openPanel(secondPage, workspace);
    await panel.getByRole("button", { name: "New group", exact: true }).click();
    await panel.getByRole("textbox", { name: "Custom callback group name" }).fill("Release review");
    await panel.getByRole("checkbox", { name: "Include frontend-review in group" }).check();
    await panel.getByRole("searchbox", { name: "Find callbacks to group" }).fill("api");
    await panel.getByRole("button", { name: "Select shown", exact: true }).click();
    await panel.getByRole("searchbox", { name: "Find callbacks to group" }).fill("");
    await expect(panel.getByText("2 selected", { exact: true })).toBeVisible();

    for (const theme of ["dark", "light"]) {
      if (await page.locator("html").getAttribute("data-theme") !== theme) {
        await page.evaluate(() => window.dispatchEvent(new Event("muxdeck:toggle-theme")));
      }
      for (const width of [390, 300]) {
        await panel.evaluate((element, value) => { (element as HTMLElement).style.width = `${value}px`; }, width);
        const layout = await panel.evaluate((element) => {
          const body = element.querySelector(".workspace-callback-body")!;
          return { width: body.clientWidth, scrollWidth: body.scrollWidth };
        });
        expect(layout.scrollWidth).toBeLessThanOrEqual(layout.width + 1);
        await panel.screenshot({ path: testInfo.outputPath(`custom-group-editor-${theme}-${width}.png`) });
      }
    }
    await panel.evaluate((element) => { (element as HTMLElement).style.width = "390px"; });
    await panel.getByRole("button", { name: "Save group" }).click();
    for (const current of [panel, peer]) {
      await expect(current.getByRole("button", { name: "Release review callback group" })).toBeVisible();
      await expect(current.getByRole("button", { name: "Ungrouped callback group" })).toBeVisible();
      const group = current.locator(".workspace-callback-group").filter({ hasText: "Release review" });
      await expect(group.locator(".workspace-callback-session strong")).toHaveText(names.slice(0, 2));
    }
    await secondPage.reload();
    await expect(peer.getByRole("button", { name: "Release review callback group" })).toBeVisible();

    // Independent browser profiles edit the same initial revision.
    await panel.getByRole("combobox", { name: "Edit custom callback group" }).selectOption({ label: "Release review" });
    await peer.getByRole("combobox", { name: "Edit custom callback group" }).selectOption({ label: "Release review" });
    await peer.getByRole("textbox", { name: "Custom callback group name" }).fill("Unsaved peer draft");
    await panel.getByRole("textbox", { name: "Custom callback group name" }).fill("Shipping");
    await panel.getByRole("checkbox", { name: "Include api-review in group" }).uncheck();
    await panel.getByRole("checkbox", { name: "Include tests-review in group" }).check();
    await panel.getByRole("button", { name: "Save group" }).click();
    await expect(peer.getByRole("button", { name: "Save group" })).toBeDisabled();
    await expect(peer.getByRole("textbox", { name: "Custom callback group name" })).toHaveValue("Unsaved peer draft");
    await peer.getByRole("button", { name: "Reload groups" }).click();
    await expect(peer.getByRole("textbox", { name: "Custom callback group name" })).toHaveValue("Shipping");
    await expect(peer.getByRole("checkbox", { name: "Include tests-review in group" })).toBeChecked();
    await expect(peer.getByRole("checkbox", { name: "Include api-review in group" })).not.toBeChecked();
    await peer.getByRole("button", { name: "Cancel", exact: true }).click();
    await panel.screenshot({ path: testInfo.outputPath("custom-callback-groups.png") });

    // Global and saved-workspace groups are separate shared sets.
    await panel.getByRole("button", { name: "Global callback scope" }).click();
    await panel.getByRole("combobox", { name: "Group callbacks by" }).selectOption("custom");
    await expect(panel.getByRole("button", { name: "Shipping callback group" })).toHaveCount(0);
    await expect(panel.getByRole("button", { name: "Ungrouped callback group" })).toBeVisible();
    await panel.getByRole("button", { name: "Workspace callback scope" }).click();
    await expect(panel.getByRole("button", { name: "Shipping callback group" })).toBeVisible();

    await peer.getByRole("combobox", { name: "Edit custom callback group" }).selectOption({ label: "Shipping" });
    await peer.getByRole("button", { name: "Delete group" }).click();
    for (const current of [panel, peer]) {
      await expect(current.getByRole("button", { name: "Shipping callback group" })).toHaveCount(0);
      await expect(current.locator(".workspace-callback-session strong")).toHaveText(names);
    }
    const snapshot = await (await context.request.get("/mux/api/callback-sessions")).json() as GlobalCallbackSnapshot;
    expect(snapshot.callbackGroups?.filter((group) => group.workspaceId === workspace.id)).toEqual([]);
    expect(snapshot.workspaceCallbacks.find((source) => source.workspaceId === workspace.id)?.sessions).toEqual(names);
  } finally {
    await secondContext.close();
    await page.close();
    expect((await context.request.delete(`/mux/api/workspaces/${workspace.id}`)).ok()).toBe(true);
  }
});
