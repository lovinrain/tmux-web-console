import { expect, test, type Locator, type Page } from "@playwright/test";
import type { CallbackMessage, GlobalCallbackSnapshot, SavedWorkspace } from "../src/api";
import type { Session } from "../src/types";
import { E2E_AUTH_PASSWORD, E2E_AUTH_USERNAME } from "./authFixture";

const currentWorkspaceId = "callback-view-current";
const otherWorkspaceId = "callback-view-other";
const queue = ["bravo-work", "alpha-ready", "charlie-ready", "delta-wait", "echo-unknown", "foxtrot-ended", "golf-shell"];
const titles = ["Bravo worker", "Alpha review", "Charlie review", "Delta command", "Echo unknown", "foxtrot-ended", "Golf shell"];

test.use({ viewport: { width: 1440, height: 1000 } });

test.beforeEach(async ({ context }) => {
  const authFile = process.env.MUXDECK_PLAYWRIGHT_AUTH_FILE;
  if (!authFile?.startsWith("/tmp/muxdeck-playwright-")) {
    throw new Error("Callback-view fixtures require disposable Playwright authentication");
  }
  const response = await context.request.post("/mux/api/auth/login", {
    data: { username: E2E_AUTH_USERNAME, password: E2E_AUTH_PASSWORD },
  });
  expect(response.ok()).toBe(true);
  await context.addInitScript(() => {
    localStorage.setItem("muxdeck-desktop-tab-orientation", "vertical");
  });
});

/** Deterministic API and stream fixtures: never create or control live sessions. */
async function installCallbacks(page: Page): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const session = (name: string, customTitle: string, agentState: Session["agentState"],
    agentType: Session["agentType"], age = 0): Session => ({
    name, customTitle, agentState, agentType, agentStateChangedAt: now - age,
    id: `$${queue.indexOf(name) + 1}`, windows: 1, attached: 0, created: now - 3600,
    serverStarted: now - 7200, serverPid: 1, activity: now, activePaneId: `%${queue.indexOf(name) + 1}`,
    agentStateReason: "Callback browser fixture", tags: [], starred: false, ignored: false,
    queuedMessageCount: 0,
    panes: [{
      id: `%${queue.indexOf(name) + 1}`, index: 0, window_index: 0, window_name: "fixture",
      window_active: true, active: true, command: agentType ?? "bash",
      path: `/tmp/callback-browser/${name}`, title: customTitle, width: 120, height: 30,
      history_size: 0, history_limit: 2000, alternate_on: false, dead: false, activity: now,
    }],
  });
  const sessions = [
    session("bravo-work", "Bravo worker", "working", "codex"),
    session("alpha-ready", "Alpha review", "waiting_human", "claude", 600),
    session("charlie-ready", "Charlie review", "waiting_human", "copilot", 1200),
    session("delta-wait", "Delta command", "waiting_command", "grok"),
    session("echo-unknown", "Echo unknown", "unknown", "cursor"),
    session("golf-shell", "Golf shell", "other", null),
  ];
  const workspaces: SavedWorkspace[] = [
    { id: currentWorkspaceId, name: "Callback view review", tabs: queue.slice(0, 2),
      callbackSessions: queue.slice(0, 2), activeSession: queue[0], sessionRevision: 1,
      createdAt: now - 3600, updatedAt: now, lastActiveAt: now },
    { id: otherWorkspaceId, name: "Another review workspace", tabs: ["charlie-ready"],
      callbackSessions: ["charlie-ready"], activeSession: "charlie-ready", sessionRevision: 1,
      createdAt: now - 3600, updatedAt: now, lastActiveAt: now },
  ];
  const reports = [
    ["alpha-ready", "claude", "Receipt feature is ready for review.", 30],
    ["charlie-ready", "copilot", "Completed browser compatibility checks.", 60],
    ["foxtrot-ended", "codex", "Archived the finished migration report.", 90],
  ] as const;
  let messages: CallbackMessage[] = reports.map(([sessionName, agentType, message, age], index) => ({
    id: `callback-view-message-${index}`, sequence: index + 1, sessionName, agentType, message,
    cwd: `/tmp/callback-browser/${sessionName}`, requestId: null, tmuxSessionId: null,
    tmuxPaneId: null, host: "callback-browser.local", createdAt: now - age, reviewedAt: null,
  }));
  let manual = [...queue];
  let revision = 1;
  let messageRevision = 1;
  const snapshot = (): GlobalCallbackSnapshot => ({
    callbackSessions: [...new Set([...manual, ...workspaces.flatMap((workspace) => workspace.callbackSessions ?? []),
      ...messages.map((message) => message.sessionName)])],
    globalCallbackSessions: [...manual], sessionRevision: revision,
    workspaceCallbacks: workspaces.map((workspace) => ({
      workspaceId: workspace.id, workspaceName: workspace.name, sessions: workspace.callbackSessions ?? [],
    })),
    callbackMessages: messages, callbackMessageRevision: messageRevision,
    latestCallbackAtBySession: Object.fromEntries(reports.map(([name, , , age]) => [name, now - age])),
  });
  await page.route("**/mux/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace(/^\/mux\/api/, "");
    const method = request.method();
    const json = (body: unknown) => route.fulfill({ json: body });
    const stream = (event: string, data: unknown) => route.fulfill({
      status: 200, contentType: "text/event-stream", body: `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`,
    });
    if (path === "/sessions") return json({ sessions, recoverableSessions: [] });
    if (path === "/sessions/stream") return stream("sessions", { sessions, recoverableSessions: [] });
    if (path === "/callback-sessions/stream") return stream("callbacks", snapshot());
    if (path === "/callback-sessions") {
      if (method === "PUT") {
        manual = (request.postDataJSON() as { sessions: string[] }).sessions;
        revision += 1;
      }
      return json(snapshot());
    }
    if (path.startsWith("/callback-messages/") && path.endsWith("/review")) {
      const id = path.split("/")[2];
      const callback = messages.find((message) => message.id === id);
      if (!callback) return route.fulfill({ status: 404, json: { error: "Unknown fixture message" } });
      messages = messages.filter((message) => message.id !== id);
      messageRevision += 1;
      return json({ callback: { ...callback, reviewedAt: now }, callbacks: snapshot() });
    }
    if (path === "/workspaces") return json({ workspaces });
    const workspaceMatch = path.match(/^\/workspaces\/([^/]+)(.*)$/);
    if (workspaceMatch) {
      const workspace = workspaces.find((item) => item.id === workspaceMatch[1]);
      if (!workspace) return route.fulfill({ status: 404, json: { error: "Unknown fixture workspace" } });
      if (workspaceMatch[2] === "/stream") return stream("workspace", { workspace, callbacks: snapshot() });
      if (workspaceMatch[2] === "/note") return json({ note: "", updatedAt: 0 });
      if (workspaceMatch[2] === "/activity") return json({ workspace });
      if (method === "PATCH") {
        const updates = request.postDataJSON() as Partial<SavedWorkspace>;
        Object.assign(workspace, updates, { updatedAt: workspace.updatedAt + 1 });
      }
      return json({ workspace });
    }
    return route.continue();
  });
}

async function openPanel(page: Page, workspaceId = currentWorkspaceId): Promise<Locator> {
  await page.goto(`/mux/?workspace=${workspaceId}`);
  await expect(page.locator(".dashboard-shell")).toBeVisible();
  const show = page.getByRole("button", { name: "Show callback list", exact: true });
  if (await show.count()) await show.click();
  const panel = page.getByRole("dialog", { name: "Callback list", exact: true });
  await expect(panel).toBeVisible();
  return panel;
}

function rowTitles(panel: Locator): Locator {
  return panel.locator(".workspace-callback-session strong");
}

function callbackGroup(panel: Locator, key: string): Locator {
  return panel.locator(`.workspace-callback-group[data-group-key="${key}"]`);
}

async function expandFilters(panel: Locator): Promise<void> {
  const more = panel.getByRole("button", { name: "More callback filters", exact: true });
  if (await more.getAttribute("aria-expanded") !== "true") await more.click();
}

test("sorts callback rows and combines search, status, agent, message, and location filters", async ({ page }) => {
  await installCallbacks(page);
  const panel = await openPanel(page);
  await panel.getByRole("button", { name: "Global callback scope", exact: true }).click();
  await expect(rowTitles(panel)).toHaveText(titles);
  await expect(panel.getByText("7 of 7 shown", { exact: true })).toBeVisible();
  const sort = panel.getByRole("combobox", { name: "Sort callbacks", exact: true });
  await sort.selectOption("name-asc");
  await expect(rowTitles(panel)).toHaveText([titles[1], titles[0], ...titles.slice(2)]);
  await sort.selectOption("name-desc");
  await expect(rowTitles(panel)).toHaveText([titles[6], titles[5], titles[4], titles[3], titles[2], titles[0], titles[1]]);
  await sort.selectOption("callback-newest");
  await expect(rowTitles(panel)).toHaveText([titles[1], titles[2], titles[5], titles[0], titles[3], titles[4], titles[6]]);
  await sort.selectOption("callback-oldest");
  await expect(rowTitles(panel)).toHaveText([titles[5], titles[2], titles[1], titles[0], titles[3], titles[4], titles[6]]);
  await sort.selectOption("ready-first");
  await expect(rowTitles(panel)).toHaveText([titles[1], titles[2], titles[6], titles[0], titles[3], titles[4], titles[5]]);
  await sort.selectOption("ready-longest");
  await expect(rowTitles(panel)).toHaveText([titles[2], titles[1], titles[6], titles[0], titles[3], titles[4], titles[5]]);
  await panel.getByRole("combobox", { name: "Filter callbacks by status", exact: true }).selectOption("ready");
  await expect(rowTitles(panel)).toHaveText([titles[2], titles[1], titles[6]]);
  await expandFilters(panel);
  await panel.getByRole("combobox", { name: "Filter callbacks by messages", exact: true }).selectOption("with-messages");
  await expect(rowTitles(panel)).toHaveText([titles[2], titles[1]]);
  await panel.getByRole("combobox", { name: "Filter callbacks by location", exact: true }).selectOption("current");
  await expect(rowTitles(panel)).toHaveText([titles[1]]);
  await panel.getByRole("combobox", { name: "Filter callbacks by agent", exact: true }).selectOption("claude");
  await panel.getByRole("searchbox", { name: "Search callbacks", exact: true }).fill("receipt feature");
  await expect(rowTitles(panel)).toHaveText([titles[1]]);
  await expect(panel.getByText("1 of 7 shown", { exact: true })).toBeVisible();
  await panel.getByRole("searchbox", { name: "Search callbacks", exact: true }).fill("not-present-anywhere");
  await expect(rowTitles(panel)).toHaveCount(0);
  await expect(panel.getByText("0 of 7 shown", { exact: true })).toBeVisible();
  await panel.getByRole("button", { name: "Reset callback filters", exact: true }).click();
  await expect(rowTitles(panel)).toHaveText([titles[2], titles[1], titles[6], titles[0], titles[3], titles[4], titles[5]]);
  await expect(sort).toHaveValue("ready-longest");
  await expect(panel.getByRole("searchbox", { name: "Search callbacks", exact: true })).toHaveValue("");
});

test("remembers view choices per scope and workspace while keeping search temporary", async ({ page }) => {
  await installCallbacks(page);
  let panel = await openPanel(page);
  await panel.getByRole("combobox", { name: "Sort callbacks", exact: true }).selectOption("callback-newest");
  await panel.getByRole("combobox", { name: "Filter callbacks by status", exact: true }).selectOption("working");
  await panel.getByRole("button", { name: "Workspace callback scope", exact: true }).click();
  await expect(panel.getByRole("combobox", { name: "Sort callbacks", exact: true })).toHaveValue("queue");
  await panel.getByRole("combobox", { name: "Sort callbacks", exact: true }).selectOption("name-desc");
  await panel.getByRole("combobox", { name: "Filter callbacks by status", exact: true }).selectOption("ready");
  await panel.getByRole("searchbox", { name: "Search callbacks", exact: true }).fill("alpha");
  await page.reload();
  await expect(panel).toBeVisible();
  await expect(panel.getByRole("combobox", { name: "Sort callbacks", exact: true })).toHaveValue("name-desc");
  await expect(panel.getByRole("combobox", { name: "Filter callbacks by status", exact: true })).toHaveValue("ready");
  await expect(panel.getByRole("searchbox", { name: "Search callbacks", exact: true })).toHaveValue("");
  await expect(rowTitles(panel)).toHaveText([titles[1]]);
  panel = await openPanel(page, otherWorkspaceId);
  await expect(panel.getByRole("combobox", { name: "Sort callbacks", exact: true })).toHaveValue("queue");
  await expect(panel.getByRole("combobox", { name: "Filter callbacks by status", exact: true })).toHaveValue("all");
  await expect(rowTitles(panel)).toHaveText([titles[2]]);
  await panel.getByRole("button", { name: "Global callback scope", exact: true }).click();
  await expect(panel.getByRole("combobox", { name: "Sort callbacks", exact: true })).toHaveValue("callback-newest");
  await expect(panel.getByRole("combobox", { name: "Filter callbacks by status", exact: true })).toHaveValue("working");
  await expect(rowTitles(panel)).toHaveText([titles[0]]);
});

test("clearing filtered ended callbacks preserves all hidden rows and messages", async ({ page }) => {
  await installCallbacks(page);
  const panel = await openPanel(page);
  await panel.getByRole("searchbox", { name: "Search callbacks", exact: true }).fill("foxtrot-ended");
  await expect(rowTitles(panel)).toHaveText([titles[5]]);
  await expect(panel.getByRole("button", { name: "Clear shown", exact: true })).toBeVisible();
  await panel.getByRole("button", { name: "Clear ended shown", exact: true }).click();
  await expect(panel.getByText("0 of 6 shown", { exact: true })).toBeVisible();
  await panel.getByRole("button", { name: "Reset callback filters", exact: true }).click();
  await expect(rowTitles(panel)).toHaveText(titles.filter((_, index) => index !== 5));
  await expect(panel.locator(".workspace-callback-message")).toHaveCount(2);
  await page.reload();
  await expect(rowTitles(panel)).toHaveText(titles.filter((_, index) => index !== 5));
  await expect(panel.locator(".workspace-callback-message")).toHaveCount(2);
});

test("groups callbacks by status, agent, or workspace with counts and sorting within each group", async ({ page }) => {
  await installCallbacks(page);
  const panel = await openPanel(page);
  const grouping = panel.getByRole("combobox", { name: "Group callbacks by", exact: true });
  await expect(grouping).toHaveValue("none");
  await grouping.selectOption("status");
  await expect(panel.locator(".workspace-callback-group-toggle")).toHaveCount(5);
  await expect(panel.locator(".workspace-callback-group-toggle").first()).toHaveAttribute("aria-expanded", "true");
  await expect(panel.locator(".workspace-callback-group-title")).toHaveText([
    "Ready", "Working", "Waiting", "Status unknown", "Ended / unavailable",
  ]);
  const ready = callbackGroup(panel, "status:ready");
  await expect(ready.locator(".workspace-callback-group-count")).toHaveText("3");
  await expect(rowTitles(ready)).toHaveText([titles[1], titles[2], titles[6]]);
  await panel.getByRole("combobox", { name: "Sort callbacks", exact: true }).selectOption("name-desc");
  await expect(rowTitles(ready)).toHaveText([titles[6], titles[2], titles[1]]);
  await expect(callbackGroup(panel, "status:working").locator(".workspace-callback-group-count")).toHaveText("1");
  await grouping.selectOption("agent");
  await expect(panel.locator(".workspace-callback-group-title")).toHaveText([
    "Claude", "Codex", "Copilot", "Cursor", "Grok", "Shells",
  ]);
  const codex = callbackGroup(panel, "agent:codex");
  await expect(codex.locator(".workspace-callback-group-count")).toHaveText("2");
  await expect(rowTitles(codex)).toHaveText([titles[5], titles[0]]);
  await grouping.selectOption("workspace");
  await expect(panel.locator(".workspace-callback-group-title")).toHaveText([
    "Another review workspace", "Callback view review", "Global queue",
  ]);
  await expect(rowTitles(callbackGroup(panel, `workspace:id:${currentWorkspaceId}`))).toHaveText([titles[0], titles[1]]);
  await expect(callbackGroup(panel, `workspace:id:${otherWorkspaceId}`).locator(".workspace-callback-group-count")).toHaveText("1");
  await expect(callbackGroup(panel, "workspace:global").locator(".workspace-callback-group-count")).toHaveText("4");
  await expect(rowTitles(callbackGroup(panel, "workspace:global"))).toHaveText([titles[6], titles[5], titles[4], titles[3]]);
  await expect(rowTitles(panel)).toHaveCount(7);
  await expect(panel.getByText("7 of 7 shown", { exact: true })).toBeVisible();
});

test("group collapse supports keyboard, scope persistence, revealing search results, and expand all", async ({ page }, testInfo) => {
  await installCallbacks(page);
  let panel = await openPanel(page);
  let grouping = panel.getByRole("combobox", { name: "Group callbacks by", exact: true });
  await grouping.selectOption("status");
  const readyToggle = panel.getByRole("button", { name: "Ready callback group", exact: true });
  await readyToggle.focus();
  await readyToggle.press("Enter");
  await expect(readyToggle).toHaveAttribute("aria-expanded", "false");
  await expect(rowTitles(panel)).toHaveCount(4);
  await expect(panel.getByText("4 of 7 shown", { exact: true })).toBeVisible();
  await expect(panel.getByText("3 collapsed", { exact: true })).toBeVisible();
  await page.reload();
  await expect(grouping).toHaveValue("status");
  await expect(readyToggle).toHaveAttribute("aria-expanded", "false");
  await expect(rowTitles(panel)).toHaveCount(4);

  // Each grouping mode remembers its own collapsed sections.
  await grouping.selectOption("agent");
  await panel.getByRole("button", { name: "Codex callback group", exact: true }).click();
  await expect(rowTitles(panel)).toHaveCount(5);
  await grouping.selectOption("status");
  await expect(readyToggle).toHaveAttribute("aria-expanded", "false");
  await panel.getByRole("combobox", { name: "Sort callbacks", exact: true }).selectOption("name-desc");
  await panel.getByRole("searchbox", { name: "Search callbacks", exact: true }).fill("alpha");
  await expect(readyToggle).toHaveAttribute("aria-expanded", "true");
  await expect(rowTitles(panel)).toHaveText([titles[1]]);
  await panel.getByRole("button", { name: "Reset callback filters", exact: true }).click();
  await expect(grouping).toHaveValue("status");
  await expect(panel.getByRole("combobox", { name: "Sort callbacks", exact: true })).toHaveValue("name-desc");
  await expect(rowTitles(panel)).toHaveCount(7);
  await grouping.selectOption("agent");
  await expect(panel.getByRole("button", { name: "Codex callback group", exact: true })).toHaveAttribute("aria-expanded", "false");
  await panel.getByRole("button", { name: "Collapse all callback groups", exact: true }).click();
  await expect(rowTitles(panel)).toHaveCount(0);
  await expect(panel.getByText("0 of 7 shown", { exact: true })).toBeVisible();
  await expect(panel.getByText("7 collapsed", { exact: true })).toBeVisible();
  await expect(panel.getByText("All matching groups are collapsed.", { exact: true })).toBeVisible();
  await expect(panel.getByRole("button", { name: /^Clear (shown|ended shown|global|all|ended)$/ })).toHaveCount(0);
  await panel.screenshot({ path: testInfo.outputPath("callback-groups-collapsed-dark.png") });
  await panel.getByRole("button", { name: "Expand all callback groups", exact: true }).click();
  await expect(rowTitles(panel)).toHaveCount(7);

  // The saved workspace has its own grouping and collapse state.
  await panel.getByRole("button", { name: "Workspace callback scope", exact: true }).click();
  await expect(grouping).toHaveValue("none");
  await grouping.selectOption("status");
  await panel.getByRole("button", { name: "Working callback group", exact: true }).click();
  await expect(rowTitles(panel)).toHaveText([titles[1]]);
  await panel.getByRole("button", { name: "Global callback scope", exact: true }).click();
  await expect(grouping).toHaveValue("agent");
  await expect(rowTitles(panel)).toHaveCount(7);
  await panel.getByRole("button", { name: "Workspace callback scope", exact: true }).click();
  await expect(grouping).toHaveValue("status");
  await expect(panel.getByRole("button", { name: "Working callback group", exact: true })).toHaveAttribute("aria-expanded", "false");
  panel = await openPanel(page, otherWorkspaceId);
  grouping = panel.getByRole("combobox", { name: "Group callbacks by", exact: true });
  await expect(grouping).toHaveValue("none");
  await expect(rowTitles(panel)).toHaveText([titles[2]]);
});

test("filtered clearing preserves callbacks and messages inside collapsed groups", async ({ page }) => {
  await installCallbacks(page);
  const panel = await openPanel(page);
  await panel.getByRole("combobox", { name: "Group callbacks by", exact: true }).selectOption("status");
  await expandFilters(panel);
  await panel.getByRole("combobox", { name: "Filter callbacks by messages", exact: true }).selectOption("with-messages");
  await panel.getByRole("button", { name: "Ready callback group", exact: true }).click();
  await expect(rowTitles(panel)).toHaveText([titles[5]]);
  await expect(panel.getByText("1 of 7 shown", { exact: true })).toBeVisible();
  await expect(panel.getByText("2 collapsed", { exact: true })).toBeVisible();
  await panel.getByRole("button", { name: "Clear shown", exact: true }).click();
  await expect(rowTitles(panel)).toHaveCount(0);
  await expect(panel.getByText("0 of 6 shown", { exact: true })).toBeVisible();
  await panel.getByRole("button", { name: "Reset callback filters", exact: true }).click();
  await expect(panel.getByRole("combobox", { name: "Group callbacks by", exact: true })).toHaveValue("status");
  await expect(rowTitles(panel)).toHaveText([titles[1], titles[2], titles[6], titles[0], titles[3], titles[4]]);
  await expect(panel.locator(".workspace-callback-message")).toHaveCount(2);
  await page.reload();
  await expect(rowTitles(panel)).toHaveText([titles[1], titles[2], titles[6], titles[0], titles[3], titles[4]]);
  await expect(panel.locator(".workspace-callback-message")).toHaveCount(2);
});

test("filter controls fit the default and narrow callback panel in both themes", async ({ page }, testInfo) => {
  await installCallbacks(page);
  const panel = await openPanel(page);
  await expandFilters(panel);
  for (const theme of ["dark", "light"] as const) {
    if (theme === "light") {
      await page.evaluate(() => window.dispatchEvent(new Event("muxdeck:toggle-theme")));
    }
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    for (const width of [390, 300]) {
      await panel.evaluate((element, targetWidth) => {
        (element as HTMLElement).style.width = `${targetWidth}px`;
      }, width);
      await expect.poll(() => panel.evaluate((element) => Math.round(element.getBoundingClientRect().width))).toBe(width);
      const layout = await panel.evaluate((element) => {
        const bounds = element.getBoundingClientRect();
        const body = element.querySelector(".workspace-callback-body")!;
        const controls = [...element.querySelectorAll("input, select")].map((control) => {
          const rect = control.getBoundingClientRect();
          return { left: rect.left, right: rect.right, width: rect.width };
        });
        return { left: bounds.left, right: bounds.right,
          bodyWidth: body.clientWidth, bodyScrollWidth: body.scrollWidth, controls };
      });
      expect(layout.bodyScrollWidth).toBeLessThanOrEqual(layout.bodyWidth + 1);
      for (const control of layout.controls) {
        expect(control.width).toBeGreaterThan(0);
        expect(control.left).toBeGreaterThanOrEqual(layout.left);
        expect(control.right).toBeLessThanOrEqual(layout.right);
      }
      await panel.getByRole("searchbox", { name: "Search callbacks", exact: true }).scrollIntoViewIfNeeded();
      await panel.screenshot({ path: testInfo.outputPath(`callback-filters-${theme}-${width}.png`) });
      await panel.getByRole("combobox", { name: "Group callbacks by", exact: true }).selectOption("status");
      await panel.getByRole("button", { name: "More callback filters", exact: true }).click();
      await expect(panel.getByRole("button", { name: "Ready callback group", exact: true })).toBeVisible();
      const groupedLayout = await panel.locator(".workspace-callback-groups").evaluate((element) => {
        const groupBounds = element.getBoundingClientRect();
        const panelBounds = element.closest(".workspace-callback-panel")!.getBoundingClientRect();
        return { width: element.clientWidth, scrollWidth: element.scrollWidth,
          right: groupBounds.right, panelRight: panelBounds.right };
      });
      expect(groupedLayout.scrollWidth).toBeLessThanOrEqual(groupedLayout.width + 1);
      expect(groupedLayout.right).toBeLessThanOrEqual(groupedLayout.panelRight);
      await panel.screenshot({ path: testInfo.outputPath(`callback-groups-${theme}-${width}.png`) });
      await panel.getByRole("combobox", { name: "Group callbacks by", exact: true }).selectOption("none");
      await expandFilters(panel);
    }
  }
});
