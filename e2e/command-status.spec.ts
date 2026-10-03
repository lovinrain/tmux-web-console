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
const grokSession = `muxdeck-grok-command-${process.pid}`;
const createdSessions: string[] = [];
const workspaceIds: string[] = [];

// Passive rendered agent fixtures exercise the real tmux capture, detector,
// API, and SSE path. A state file changes the screen; no terminal input is sent.
const fixtureScript = `
import ctypes
import pathlib
import sys
import time

provider = sys.argv[2] if len(sys.argv) > 2 else "claude"
assert ctypes.CDLL(None).prctl(15, provider.encode(), 0, 0, 0) == 0
state_file = pathlib.Path(sys.argv[1])
previous = None
last_render = 0
while True:
    state = state_file.read_text().strip()
    now = time.monotonic()
    if state != previous or (state in {"working", "command"} and now - last_render >= 1):
        if provider == "grok":
            title = "⠸ - Waiting for response… - grok" if state == "working" else "Fixture task - grok"
            footer = "Shift+Tab:mode │ Ctrl+.:shortcuts"
            activity = "◆ Finished the task\\n"
            if state == "working":
                activity = "⠸ Waiting for response… 2s      5m ⇣192k [stop]\\n"
                footer = "Shift+Tab:mode │ Ctrl+c:cancel │ Ctrl+.:shortcuts"
            elif state == "command":
                activity = "⠸ Deploy fixture service… 37s      5m ⇣192k [stop]\\n▾ Tasks 1\\n⁙ Run Deploy fixture service 39s\\n"
            screen = activity + "╭────────────────────────╮\\n│ ❯                     │\\n╰─── Grok 4.7 Fast ───────╯\\n" + footer
        else:
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
  const grokStateFile = join(fixtureDirectory, `${grokSession}.state`);
  writeFileSync(grokStateFile, "working");
  execFileSync("tmux", [
    ...tmux, "new-session", "-d", "-s", grokSession, "-x", "160", "-y", "30",
    "bash", "--noprofile", "--norc", "-c", 'exec -a grok python3 "$@"', "grok", script, grokStateFile, "grok",
  ]);
  createdSessions.push(grokSession);
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
    await expect(workspacePage.locator(".workspace-callback-card small")).toHaveText(["Global 1/3", "Local 1/3"]);
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
  await expect(workspacePage.locator(".workspace-callback-card small")).toHaveText(["Global 2/3", "Local 2/3"]);
});

test("Grok background commands with settled titles stay busy and highlight only after finishing", async ({
  page, context,
}, testInfo) => {
  test.setTimeout(60_000);
  const readState = async () => {
    const body = await (await context.request.get("/mux/api/sessions")).json();
    return body.sessions.find((session: { name: string }) => session.name === grokSession)?.agentState;
  };
  await expect.poll(readState).toBe("working");
  const response = await context.request.post("/mux/api/workspaces", {
    data: { name: "Grok command readiness", tabs: [grokSession, sessions.ready], activeSession: grokSession },
  });
  expect(response.ok()).toBe(true);
  const workspace = (await response.json()).workspace as SavedWorkspace;
  workspaceIds.push(workspace.id);
  expect((await context.request.post(`/mux/api/workspaces/${workspace.id}/callback-sessions`, {
    data: { sessions: [grokSession], sessionRevision: workspace.sessionRevision },
  })).ok()).toBe(true);
  await page.goto(`/mux/session/${grokSession}?workspace=${workspace.id}`);
  const grokTab = tab(page, grokSession);
  await expect(grokTab.locator(".workspace-state-dot")).toHaveClass(/working/);
  // Visiting while it works must not acknowledge the later Ready event.
  await grokTab.getByRole("tab").click();
  const show = page.getByRole("button", { name: "Show callback list", exact: true });
  if (await show.count()) await show.click();
  await page.getByRole("button", { name: "Global callback scope", exact: true }).click();

  writeFileSync(join(fixtureDirectory, `${grokSession}.state`), "command");
  await expect.poll(readState).toBe("running_command");
  await expect(grokTab.locator(".workspace-state-dot")).toHaveClass(/running_command/, { timeout: 10_000 });
  await expect(callbackRow(page, grokSession).locator(".workspace-callback-status")).toHaveText("Command running");
  await expect(page.locator(".workspace-callback-card small")).toHaveText(["Global 0/1", "Local 0/1"]);
  await expect(grokTab).not.toHaveAttribute("data-ready-unchecked");

  writeFileSync(join(fixtureDirectory, `${grokSession}.state`), "ready");
  await expect.poll(readState).toBe("waiting_human");
  await expect(grokTab).toHaveAttribute("data-ready-unchecked", "true", { timeout: 10_000 });
  await expect(callbackRow(page, grokSession).locator(".workspace-callback-status")).toHaveText("Ready for review");
  await expect(page.locator(".workspace-callback-card small")).toHaveText(["Global 1/1", "Local 1/1"]);
  await page.screenshot({ path: testInfo.outputPath("grok-task-finished-unchecked.png"), animations: "disabled" });
  await grokTab.getByRole("tab").click();
  await expect(grokTab).not.toHaveAttribute("data-ready-unchecked");
  await expect(callbackRow(page, grokSession).locator(".workspace-callback-status")).toHaveText("Ready for review");
});
