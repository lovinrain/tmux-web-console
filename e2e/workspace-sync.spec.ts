import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import type { GlobalCallbackSnapshot, SavedWorkspace } from "../src/api";
import { E2E_AUTH_PASSWORD, E2E_AUTH_USERNAME } from "./authFixture";

// Missing session names exercise workspace behavior without creating or touching tmux.
const workspaceIds: string[] = [];
const tabRows = (page: Page) => page.locator(".workspace-tab[data-workspace-session-name]");
const tabRow = (page: Page, name: string) => page.locator(
  `.workspace-tab[data-workspace-session-name="${name}"]`,
);

test.use({ viewport: { width: 1440, height: 700 } });

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

async function createWorkspace(
  request: APIRequestContext,
  name: string,
  count: number,
): Promise<SavedWorkspace> {
  const tabs = Array.from({ length: count }, (_, index) => (
    `missing-${name}-${String(index + 1).padStart(2, "0")}`
  ));
  const response = await request.post("/mux/api/workspaces", {
    data: { name: `Browser ${name}`, tabs, activeSession: tabs[0], groups: [] },
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
  await expect(tabRows(page)).toHaveCount(workspace.tabs.length);
  await expect(tabRow(page, workspace.tabs[0]).getByRole("tab"))
    .toHaveAttribute("aria-selected", "true");
  await page.evaluate(() => document.fonts.ready);
}

async function expectTabs(page: Page, tabs: string[]): Promise<void> {
  await expect.poll(() => tabRows(page).evaluateAll((rows) => (
    rows.map((row) => row.getAttribute("data-workspace-session-name"))
  ))).toEqual(tabs);
  await expect.poll(() => new URL(page.url()).searchParams.getAll("tab")).toEqual(tabs);
}

async function closeTab(page: Page, name: string): Promise<void> {
  await tabRow(page, name).getByRole("button", {
    name: `Close ${name} quick tab`, exact: true,
  }).click();
}

async function finishLayout(page: Page): Promise<void> {
  await page.evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  }));
}

test("workspace closes reach another tab without moving its focus or resurrecting on pagehide", async ({
  page, context,
}) => {
  const workspace = await createWorkspace(context.request, "shared-close", 5);
  await openWorkspace(page, workspace);
  const secondPage = await context.newPage();
  await openWorkspace(secondPage, workspace);
  await tabRow(secondPage, workspace.tabs[1]).getByRole("tab").click();
  await expect(tabRow(secondPage, workspace.tabs[1]).getByRole("tab"))
    .toHaveAttribute("aria-selected", "true");
  await expect.poll(async () => (await readWorkspace(context.request, workspace.id)).activeSession)
    .toBe(workspace.tabs[1]);
  const staleWorkspace = await readWorkspace(context.request, workspace.id);

  const closedName = workspace.tabs[3];
  const remaining = workspace.tabs.filter((name) => name !== closedName);
  await closeTab(page, closedName);
  await expectTabs(page, remaining);
  await expectTabs(secondPage, remaining);
  await expect(tabRow(page, workspace.tabs[0]).getByRole("tab"))
    .toHaveAttribute("aria-selected", "true");
  await expect(tabRow(secondPage, workspace.tabs[1]).getByRole("tab"))
    .toHaveAttribute("aria-selected", "true");

  // An unload request created before the close must not replace the newer list.
  const staleSave = await secondPage.request.post(`/mux/api/workspaces/${workspace.id}/activity`, {
    data: {
      tabs: staleWorkspace.tabs,
      groups: staleWorkspace.groups,
      activeSession: staleWorkspace.activeSession,
      sessionRevision: staleWorkspace.sessionRevision,
      expectedUpdatedAt: staleWorkspace.updatedAt,
    },
  });
  expect(staleSave.status()).toBe(409);
  await secondPage.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pagehide")));
  await page.reload();
  await secondPage.reload();
  await expectTabs(page, remaining);
  await expectTabs(secondPage, remaining);
  expect((await readWorkspace(context.request, workspace.id)).tabs).toEqual(remaining);
});

test("concurrent closes from the same workspace revision preserve both removals", async ({
  page, context,
}) => {
  const workspace = await createWorkspace(context.request, "concurrent-close", 5);
  await openWorkspace(page, workspace);
  const secondPage = await context.newPage();
  await openWorkspace(secondPage, workspace);

  let releaseRequests!: () => void;
  const requestsHeld = new Promise<void>((resolve) => { releaseRequests = resolve; });
  const pendingBodies: unknown[] = [];
  const activityUrl = `**/api/workspaces/${workspace.id}/activity`;
  await context.route(activityUrl, async (route) => {
    const body = route.request().postDataJSON() as { tabs?: string[] };
    const removesTarget = body.tabs && (
      !body.tabs.includes(workspace.tabs[2]) || !body.tabs.includes(workspace.tabs[3])
    );
    if (removesTarget && pendingBodies.length < 2) {
      pendingBodies.push(body);
      await requestsHeld;
    }
    await route.continue();
  });
  try {
    await Promise.all([
      closeTab(page, workspace.tabs[2]),
      closeTab(secondPage, workspace.tabs[3]),
    ]);
    // Hold both first writes so neither page sees the other close before saving.
    await expect.poll(() => pendingBodies.length).toBe(2);
    releaseRequests();
    const remaining = workspace.tabs.filter((_, index) => index !== 2 && index !== 3);
    await expectTabs(page, remaining);
    await expectTabs(secondPage, remaining);
    await expect.poll(async () => (await readWorkspace(context.request, workspace.id)).tabs)
      .toEqual(remaining);
  } finally {
    releaseRequests();
    await context.unroute(activityUrl);
  }
});

test("two workspace dashboards keep browser requests flowing while syncing callbacks and tabs", async ({
  page, context,
}) => {
  const workspace = await createWorkspace(context.request, "dashboard-streams", 4);
  type StreamObservation = {
    sources: EventSource[];
    callbacks: GlobalCallbackSnapshot | null;
  };
  await context.addInitScript(() => {
    const observed: StreamObservation = { sources: [], callbacks: null };
    (window as unknown as { workspaceStreams: StreamObservation }).workspaceStreams = observed;
    const NativeEventSource = window.EventSource;
    window.EventSource = class extends NativeEventSource {
      constructor(url: string | URL, options?: EventSourceInit) {
        super(url, options);
        observed.sources.push(this);
        if (this.url.includes("/api/workspaces/")) {
          this.addEventListener("workspace", (event) => {
            observed.callbacks = JSON.parse((event as MessageEvent<string>).data).callbacks ?? null;
          });
        }
      }
    };
  });
  const secondPage = await context.newPage();
  const pages = [page, secondPage];
  await Promise.all(pages.map(async (dashboard) => {
    await dashboard.goto(`/mux/?workspace=${workspace.id}`);
    await expect(dashboard.locator(".dashboard-workspace-resume"))
      .toHaveAttribute("aria-label", /4 open tabs/);
    await expect(dashboard.getByRole("heading", { name: workspace.name, exact: true }))
      .toBeVisible();
    await expect.poll(() => dashboard.evaluate(() => {
      const observed = (window as unknown as { workspaceStreams: StreamObservation }).workspaceStreams;
      return observed.sources.filter((source) => source.readyState === EventSource.OPEN)
        .map((source) => new URL(source.url).pathname);
    })).toEqual(expect.arrayContaining([
      "/mux/api/sessions/stream",
      `/mux/api/workspaces/${workspace.id}/stream`,
    ]));
  }));

  // These fetches use Chromium's shared origin pool. APIRequestContext would
  // bypass the six-connection HTTP/1.1 limit and miss stream starvation.
  await Promise.all(pages.map(async (dashboard) => {
    const status = await dashboard.evaluate(async () => {
      const response = await fetch("/mux/api/workspaces", { signal: AbortSignal.timeout(3_000) });
      await response.json();
      return response.status;
    });
    expect(status).toBe(200);
  }));

  const callbackStatus = await page.evaluate(async ({ id, callbackSession }) => {
    const response = await fetch(`/mux/api/workspaces/${id}`, { signal: AbortSignal.timeout(3_000) });
    const { workspace: saved } = await response.json() as { workspace: SavedWorkspace };
    const updated = await fetch(`/mux/api/workspaces/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        callbackSessions: [callbackSession],
        sessionRevision: saved.sessionRevision,
        expectedUpdatedAt: saved.updatedAt,
      }),
      signal: AbortSignal.timeout(3_000),
    });
    await updated.json();
    return updated.status;
  }, { id: workspace.id, callbackSession: workspace.tabs[0] });
  expect(callbackStatus).toBe(200);
  for (const dashboard of pages) {
    await expect.poll(() => dashboard.evaluate(() => (
      (window as unknown as { workspaceStreams: StreamObservation }).workspaceStreams.callbacks
        ?.callbackSessions
    ))).toEqual([workspace.tabs[0]]);
  }

  const remaining = workspace.tabs.slice(0, 3);
  const closeStatus = await secondPage.evaluate(async ({ id, tabs }) => {
    const response = await fetch(`/mux/api/workspaces/${id}`, { signal: AbortSignal.timeout(3_000) });
    const { workspace: saved } = await response.json() as { workspace: SavedWorkspace };
    const updated = await fetch(`/mux/api/workspaces/${id}/activity`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        tabs, groups: [], activeSession: tabs[0],
        sessionRevision: saved.sessionRevision,
        expectedUpdatedAt: saved.updatedAt,
      }),
      signal: AbortSignal.timeout(3_000),
    });
    await updated.json();
    return updated.status;
  }, { id: workspace.id, tabs: remaining });
  expect(closeStatus).toBe(200);
  for (const dashboard of pages) {
    await expect(dashboard.locator(".dashboard-workspace-resume"))
      .toHaveAttribute("aria-label", /3 open tabs/);
  }
  await Promise.all(pages.map(async (dashboard) => {
    await dashboard.locator(".dashboard-workspace-resume").click();
    await expectTabs(dashboard, remaining);
  }));
});

test("long sidebars keep the next close control in place after inactive and active removals", async ({
  page, context,
}) => {
  const workspace = await createWorkspace(context.request, "long-sidebar", 80);
  await openWorkspace(page, workspace);
  const viewport = page.locator(".workspace-tab-viewport");
  const removedInactive = workspace.tabs[49];
  await tabRow(page, removedInactive).evaluate((element) => {
    const viewport = element.closest<HTMLElement>(".workspace-tab-viewport")!;
    viewport.scrollTop += element.getBoundingClientRect().top
      - viewport.getBoundingClientRect().top - viewport.clientHeight / 2;
  });
  const initialScroll = await viewport.evaluate((element) => element.scrollTop);
  expect(initialScroll).toBeGreaterThan(500);
  const closeY = (await tabRow(page, removedInactive).boundingBox())!.y;

  await closeTab(page, removedInactive);
  await expect(tabRow(page, removedInactive)).toHaveCount(0);
  await expect.poll(async () => (await readWorkspace(context.request, workspace.id)).tabs.length)
    .toBe(79);
  await finishLayout(page);
  await expect.poll(async () => Math.abs(
    await viewport.evaluate((element) => element.scrollTop) - initialScroll,
  )).toBeLessThanOrEqual(1);
  await expect.poll(async () => Math.abs(
    (await tabRow(page, workspace.tabs[50]).boundingBox())!.y - closeY,
  )).toBeLessThanOrEqual(1);

  const removedActive = workspace.tabs[50];
  await tabRow(page, removedActive).getByRole("tab").click();
  await expect(tabRow(page, removedActive).getByRole("tab"))
    .toHaveAttribute("aria-selected", "true");
  await finishLayout(page);
  const activeScroll = await viewport.evaluate((element) => element.scrollTop);
  const activeCloseY = (await tabRow(page, removedActive).boundingBox())!.y;
  await closeTab(page, removedActive);
  await expect(tabRow(page, removedActive)).toHaveCount(0);
  await expect.poll(async () => (await readWorkspace(context.request, workspace.id)).tabs.length)
    .toBe(78);
  await finishLayout(page);
  await expect.poll(async () => Math.abs(
    await viewport.evaluate((element) => element.scrollTop) - activeScroll,
  )).toBeLessThanOrEqual(1);
  await expect.poll(async () => Math.abs(
    (await tabRow(page, workspace.tabs[51]).boundingBox())!.y - activeCloseY,
  )).toBeLessThanOrEqual(1);

  // Explicit selection still reveals an offscreen tab; deletion alone does not.
  const first = tabRow(page, workspace.tabs[0]).getByRole("tab");
  await first.evaluate((element) => (element as HTMLButtonElement).click());
  await expect(first).toHaveAttribute("aria-selected", "true");
  await expect.poll(() => viewport.evaluate((element) => element.scrollTop)).toBeLessThan(100);
});
