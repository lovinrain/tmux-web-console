import { execFileSync } from "node:child_process";
import { expect, test } from "@playwright/test";
import { E2E_AUTH_PASSWORD, E2E_AUTH_USERNAME } from "./authFixture";

const socket = process.env.MUXDECK_PLAYWRIGHT_TMUX_SOCKET;
if (!socket) throw new Error("Disposable tmux socket must be configured");
const tmux = ["-L", socket];
const originalName = `muxdeck-worker-link-${process.pid}`;
const renamedName = `${originalName}-renamed`;

function nativeIdentity(name: string): URLSearchParams {
  const values = execFileSync("tmux", [...tmux, "list-panes", "-t", `=${name}`, "-F",
    "#{session_id}|#{session_created}|#{start_time}|#{pid}|#{pane_id}|#{pane_pid}"], { encoding: "utf8" }).trim().split("|");
  return new URLSearchParams(Object.fromEntries([
    "sessionId", "sessionCreated", "serverStarted", "serverPid", "paneId", "panePid",
  ].map((field, index) => [field, values[index]])));
}

function sendOutput(name: string, marker: string) {
  const pane = nativeIdentity(name).get("paneId")!;
  execFileSync("tmux", [...tmux, "send-keys", "-t", pane, "-l", `printf '${marker}\\n'`]);
  execFileSync("tmux", [...tmux, "send-keys", "-t", pane, "Enter"]);
}

test.beforeEach(async ({ context }) => {
  const login = await context.request.post("/mux/api/auth/login", {
    data: { username: E2E_AUTH_USERNAME, password: E2E_AUTH_PASSWORD },
  });
  expect(login.ok()).toBe(true);
});

test.afterEach(() => {
  for (const name of [originalName, renamedName]) {
    try { execFileSync("tmux", [...tmux, "kill-session", "-t", `=${name}`], { stdio: "ignore" }); }
    catch { /* Exact test-owned names on the disposable socket only. */ }
  }
});

test("worker deep link follows rename, refreshes read-only output, and keeps history after name reuse", async ({ page, context }) => {
  execFileSync("tmux", [...tmux, "new-session", "-d", "-s", originalName, "bash", "--noprofile", "--norc"]);
  const identity = nativeIdentity(originalName);
  identity.set("workspace", "workspace-browser-test");
  identity.set("runId", "run-browser-test");
  identity.set("providerExecutionId", "provider-browser-test");
  sendOutput(originalName, "WORKER_ORIGINAL_CAPTURE");
  const inputs: string[] = [];
  page.on("request", (request) => {
    if (request.method() !== "GET" && /\/api\/|\/ws\//.test(request.url())) inputs.push(request.url());
  });
  await page.goto(`/mux/worker?${identity}`);
  await expect(page.getByTestId("worker-terminal-state")).toContainText("Live worker");
  await expect(page.getByLabel("Worker terminal output")).toContainText("WORKER_ORIGINAL_CAPTURE");
  await expect(page.getByText("Read-only output.", { exact: false })).toBeVisible();
  await page.getByLabel("Worker terminal output").focus();
  await page.keyboard.type("THIS_MUST_NOT_REACH_THE_WORKER");
  expect(inputs).toEqual([]);
  sendOutput(originalName, "WORKER_REFRESHED_CAPTURE");
  await expect(page.getByLabel("Worker terminal output")).toContainText("WORKER_REFRESHED_CAPTURE");
  const beforeNavigation = nativeIdentity(originalName).toString();
  await page.goto("about:blank");
  expect(nativeIdentity(originalName).toString()).toBe(beforeNavigation);
  await page.goto(`/mux/worker?${identity}`);
  await expect(page.getByTestId("worker-terminal-state")).toContainText("Live worker");
  execFileSync("tmux", [...tmux, "rename-session", "-t", `=${originalName}`, renamedName]);
  await expect(page.getByTestId("worker-terminal-state")).toContainText(renamedName);
  execFileSync("tmux", [...tmux, "kill-session", "-t", `=${renamedName}`]);
  execFileSync("tmux", [...tmux, "new-session", "-d", "-s", originalName, "bash", "--noprofile", "--norc"]);
  sendOutput(originalName, "REPLACEMENT_MUST_NOT_APPEAR");
  await page.reload();
  await expect(page.getByTestId("worker-terminal-state")).toContainText("Worker ended");
  await expect(page.getByLabel("Worker terminal output")).toContainText("WORKER_REFRESHED_CAPTURE");
  await expect(page.getByLabel("Worker terminal output")).not.toContainText("REPLACEMENT_MUST_NOT_APPEAR");
  await page.screenshot({ path: "/tmp/muxpilot-worker-ended.png", fullPage: true });
  await page.close();
  const sessions = await context.request.get("/mux/api/sessions");
  expect((await sessions.json()).sessions.some((session: { name: string }) => session.name === originalName)).toBe(true);
});

test("incomplete worker association explains the error without selecting a named terminal", async ({ page }) => {
  await page.goto(`/mux/worker?session=${originalName}`);
  await expect(page.getByRole("alert")).toContainText("invalid");
  await expect(page.getByLabel("Worker terminal output")).toBeEmpty();
});
