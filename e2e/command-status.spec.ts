import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, type Locator, type Page } from "@playwright/test";
import type { SavedWorkspace } from "../src/api";
import { E2E_AUTH_PASSWORD, E2E_AUTH_USERNAME } from "./authFixture";

const socketName = process.env.MUXDECK_PLAYWRIGHT_TMUX_SOCKET;
if (!socketName?.startsWith("muxdeck-playwright-")) {
  throw new Error("Command-status fixtures require the disposable Playwright tmux socket");
}
const tmux = ["-L", socketName];
const fixtureDirectory = mkdtempSync(join(tmpdir(), "muxdeck-playwright-command-"));
const reviewDirectory = "/tmp/muxdeck-running-command-browser-review";
const sessions = {
  command: `muxdeck-command-${process.pid}`,
  working: `muxdeck-thinking-${process.pid}`,
  ready: `muxdeck-ready-${process.pid}`,
};
const createdSessions: string[] = [];
const workspaceIds: string[] = [];

// A passive rendered Claude fixture exercises the real tmux capture, detector,
// API, and SSE path. A state file changes the screen; no terminal input is sent.
const fixtureScript = `
import ctypes
import pathlib
import sys
import time

assert ctypes.CDLL(None).prctl(15, b"claude", 0, 0, 0) == 0
state_file = pathlib.Path(sys.argv[1])
previous = None
last_render = 0
while True:
    state = state_file.read_text().strip()
    now = time.monotonic()
    if state != previous or (state == "working" and now - last_render >= 1):
        title = "◐ Fixture thinking" if state == "working" else "✳ Fixture ready"
        footer = "⏵⏵ bypass permissions on (shift+tab to cycle)"
        if state == "command":
            footer += " · 1 shell · ↓ to manage"
        screen = "● Command started.\\n\\n❯ \\n" + footer
        sys.stdout.write("\\033]2;" + title + "\\007\\033[2J\\033[H" + screen + "\\n")
        sys.stdout.flush()
        previous = state
        last_render = now
    time.sleep(0.1)
`;

test.use({ viewport: { width: 1440, height: 1000 } });

test.beforeAll(() => {
  mkdirSync(reviewDirectory, { recursive: true });
  const script = join(fixtureDirectory, "render_claude.py");
  writeFileSync(script, fixtureScript);
  for (const [state, name] of Object.entries(sessions)) {
    const stateFile = join(fixtureDirectory, `${name}.state`);
    writeFileSync(stateFile, state);
    execFileSync("tmux", [
      ...tmux, "new-session", "-d", "-s", name, "-x", "160", "-y", "30",
      "bash", "--noprofile", "--norc", "-c", 'exec -a claude python3 "$@"', "claude", script, stateFile,
    ]);
    createdSessions.push(name);
  }
});

test.beforeEach(async ({ context }) => {
  const response = await context.request.post("/mux/api/auth/login", {
    data: { username: E2E_AUTH_USERNAME, password: E2E_AUTH_PASSWORD },
  });
  expect(response.ok()).toBe(true);
  await context.addInitScript(() => {
    localStorage.setItem("muxdeck-desktop-tab-orientation", "vertical");
    const NativeEventSource = window.EventSource;
    const observedStates: Record<string, string>[] = [];
    Object.assign(window, { commandStatusEvents: observedStates });
    window.EventSource = class extends NativeEventSource {
      constructor(url: string | URL, options?: EventSourceInit) {
        super(url, options);
        this.addEventListener("sessions", (event) => {
          const snapshot = JSON.parse((event as MessageEvent<string>).data);
          observedStates.push(Object.fromEntries(snapshot.sessions.map(
            (session: { name: string; agentState: string }) => [session.name, session.agentState],
          )));
        });
      }
    };
  });
});

test.afterEach(async ({ context }) => {
  await Promise.all(context.pages().map((page) => page.close()));
  for (const id of workspaceIds.splice(0)) {
    expect((await context.request.delete(`/mux/api/workspaces/${id}`)).ok()).toBe(true);
  }
});

test.afterAll(() => {
  for (const name of createdSessions) {
    execFileSync("tmux", [...tmux, "kill-session", "-t", `=${name}`]);
  }
  rmSync(fixtureDirectory, { recursive: true, force: true });
});

function card(page: Page, name: string): Locator {
  return page.locator(".session-card").filter({ has: page.getByRole("heading", { name, exact: true }) });
}

function tab(page: Page, name: string): Locator {
  return page.locator(`.workspace-tab[data-workspace-session-name="${name}"]`);
}

function callbackRow(page: Page, name: string): Locator {
  return page.locator(".workspace-callback-item").filter({ has: page.getByText(name, { exact: true }) });
}

async function color(locator: Locator, property: "color" | "backgroundColor"): Promise<string> {
  return locator.evaluate((element, key) => getComputedStyle(element)[key], property);
}

async function expectStreamState(page: Page, name: string, state: string): Promise<void> {
  await expect.poll(() => page.evaluate(({ sessionName, expected }) => (
    (window as unknown as { commandStatusEvents: Record<string, string>[] }).commandStatusEvents
      .some((snapshot) => snapshot[sessionName] === expected)
  ), { sessionName: name, expected: state })).toBe(true);
}

test("a real command status stays blue and busy until its shell finishes, including live callback counts", async ({
  page, context,
}) => {
  test.setTimeout(60_000);
  await expect.poll(async () => {
    const response = await context.request.get("/mux/api/sessions");
    const body = await response.json();
    return Object.fromEntries(body.sessions.filter((session: { name: string }) => (
      Object.values(sessions).includes(session.name)
    )).map((session: { name: string; agentState: string }) => [session.name, session.agentState]));
  }).toEqual({
    [sessions.command]: "running_command",
    [sessions.working]: "working",
    [sessions.ready]: "waiting_human",
  });
  const response = await context.request.post("/mux/api/workspaces", {
    data: { name: "Command status review", tabs: Object.values(sessions), activeSession: sessions.command },
  });
  expect(response.ok()).toBe(true);
  const workspace = (await response.json()).workspace as SavedWorkspace;
  workspaceIds.push(workspace.id);
  const registered = await context.request.post(`/mux/api/workspaces/${workspace.id}/callback-sessions`, {
    data: { sessions: Object.values(sessions), sessionRevision: workspace.sessionRevision },
  });
  expect(registered.ok()).toBe(true);

  await page.goto("/mux/");
  const workspacePage = await context.newPage();
  await workspacePage.goto(`/mux/session/${sessions.command}?workspace=${workspace.id}`);
  await expect(workspacePage.locator(".connection-badge")).toContainText("Live");
  const show = workspacePage.getByRole("button", { name: "Show callback list", exact: true });
  if (await show.count()) await show.click();
  await workspacePage.getByRole("button", { name: "Global callback scope", exact: true }).click();

  for (const theme of ["dark", "light"]) {
    if (theme === "light") {
      for (const current of [page, workspacePage]) {
        await current.evaluate(() => window.dispatchEvent(new Event("muxdeck:toggle-theme")));
        await expect(current.locator("html")).toHaveAttribute("data-theme", theme);
      }
    }
    await expect(card(page, sessions.command).locator(".state-badge")).toHaveText("Command running");
    await expect(card(page, sessions.working).locator(".state-badge")).toHaveText("Working");
    await expect(card(page, sessions.ready).locator(".state-badge")).toHaveText("Needs input");
    await expect(callbackRow(workspacePage, sessions.command).locator(".workspace-callback-status"))
      .toHaveText("Command running");
    await expect(callbackRow(workspacePage, sessions.working).locator(".workspace-callback-status"))
      .toHaveText("Working");
    await expect(callbackRow(workspacePage, sessions.ready).locator(".workspace-callback-status"))
      .toHaveText("Ready for review");
    await expect(workspacePage.locator(".workspace-callback-card small")).toHaveText("1/3 ready");
    const colors = await Promise.all(Object.values(sessions).map((name) => color(card(page, name).locator(".state-badge"), "color")));
    expect(new Set(colors).size).toBe(3);
    const tabColors = await Promise.all(Object.values(sessions).map((name) => color(tab(workspacePage, name).locator(".workspace-state-dot"), "backgroundColor")));
    const callbackColors = await Promise.all(Object.values(sessions).map((name) => color(callbackRow(workspacePage, name).locator(".workspace-callback-status-dot"), "backgroundColor")));
    expect(new Set(tabColors).size).toBe(3);
    expect(new Set(callbackColors).size).toBe(3);
    expect(tabColors[0]).toBe(colors[0]);
    expect(callbackColors[0]).toBe(colors[0]);
    expect(await color(callbackRow(workspacePage, sessions.command).locator(".workspace-callback-status"), "color"))
      .toBe(colors[0]);
    await page.locator('.session-section[aria-labelledby="sessions-heading"]')
      .screenshot({ path: join(reviewDirectory, `command-dashboard-${theme}.png`) });
    await workspacePage.screenshot({ path: join(reviewDirectory, `command-workspace-${theme}.png`) });
  }

  await expectStreamState(page, sessions.command, "running_command");
  writeFileSync(join(fixtureDirectory, `${sessions.command}.state`), "ready");
  // The dashboard receives the real SSE event. The workspace's existing
  // inventory poll updates its sidebar and callback count without a reload.
  await expectStreamState(page, sessions.command, "waiting_human");
  await expect(card(page, sessions.command).locator(".state-badge")).toHaveText("Needs input");
  await expect(tab(workspacePage, sessions.command).locator(".workspace-state-dot"))
    .toHaveClass(/waiting_human/, { timeout: 10_000 });
  await expect(callbackRow(workspacePage, sessions.command).locator(".workspace-callback-status"))
    .toHaveText("Ready for review");
  await expect(workspacePage.locator(".workspace-callback-card small")).toHaveText("2/3 ready");
});
