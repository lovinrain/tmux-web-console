import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { E2E_AUTH_PASSWORD, E2E_AUTH_USERNAME } from "./authFixture";

const socket = process.env.MUXDECK_PLAYWRIGHT_TMUX_SOCKET;
if (!socket?.startsWith("muxdeck-playwright-")) throw new Error("Held-view tests require a disposable tmux socket");
const tmux = ["-L", socket];
const directory = mkdtempSync(join(tmpdir(), "muxdeck-playwright-held-view-"));
const source = "muxdeck-held-view-" + process.pid;
const other = source + "-other";
const url = (name: string) => "/mux/session/" + name + "?tab=" + source + "&tab=" + other;

test.beforeAll(() => {
  const script = join(directory, "grok_fixture.py");
  writeFileSync(script, `import ctypes
import re
import sys
import time
assert ctypes.CDLL(None).prctl(15, b"grok", 0, 0, 0) == 0
def render(text, working=False):
    title = "⠸ - Waiting for response… - grok" if working else "Reading fixture - grok"
    activity = "⠸ Waiting for response… 2s      5m ⇣192k [stop]" if working else "◆ Finished the task"
    footer = "Shift+Tab:mode │ Ctrl+c:cancel │ Ctrl+.:shortcuts" if working else "Space:prompt │ Enter:open │ Ctrl+e:expand thinking │ Ctrl+.:shortcuts"
    screen = "READING ANCHOR — original paragraph\\n" + text + "\\n" + activity + "\\n╭───────────────────────────────────────────────────╮\\n│ ❯ Build anything                                  │\\n╰──── Grok 4.7 Fast (xhigh) · always-approve ─────────╯\\n" + footer
    sys.stdout.write("\\033]2;" + title + "\\007\\033[2J\\033[H" + screen + "\\n")
    sys.stdout.flush()
render("No question received yet")
for line in sys.stdin:
    question = re.sub(r"\\x1b\\[[0-?]*[ -/]*[@-~]", "", line).strip()
    if not question: continue
    render("RECEIVED " + question, True)
    time.sleep(1.5)
    render("RESULT " + question)
`);
  execFileSync("tmux", [...tmux, "new-session", "-d", "-s", source, "-x", "120", "-y", "30",
    "bash", "--noprofile", "--norc", "-c", 'exec -a grok python3 "$@"', "grok", script]);
  execFileSync("tmux", [...tmux, "new-session", "-d", "-s", other, "sh", "-c", "printf 'OTHER SESSION\\n'; exec cat"]);
});

test.afterAll(() => {
  for (const name of [source, other]) {
    try { execFileSync("tmux", [...tmux, "kill-session", "-t", "=" + name], { stdio: "ignore" }); }
    catch { /* Only this test's disposable sessions. */ }
  }
  rmSync(directory, { recursive: true, force: true });
});

test("optional send holds the old pixels while live input, completion and other views keep working", async ({ page, context }, info) => {
  test.setTimeout(90_000);
  page.setDefaultTimeout(12_000);
  await page.setViewportSize({ width: 1440, height: 1000 });
  expect((await context.request.post("/mux/api/auth/login", {
    data: { username: E2E_AUTH_USERNAME, password: E2E_AUTH_PASSWORD },
  })).ok()).toBe(true);
  await context.addInitScript(() => localStorage.setItem("muxdeck-desktop-tab-orientation", "vertical"));
  await page.goto(url(source));
  await expect(page.locator(".connection-badge")).toContainText("Live");
  await expect(page.locator(".xterm-rows")).toContainText("READING ANCHOR");
  const composer = page.getByRole("textbox", { name: "Staged input", exact: true });
  const held = page.getByRole("region", { name: "Held terminal view", exact: true });
  await composer.fill("normal question");
  await page.getByRole("button", { name: "Send + Enter", exact: true }).click();
  await expect(page.locator(".xterm-rows")).toContainText("RESULT normal question");
  await expect(held).toHaveCount(0);

  const twin = await context.newPage();
  await twin.setViewportSize({ width: 1440, height: 1000 });
  await twin.goto(url(source));
  await expect(twin.locator(".xterm-rows")).toContainText("RESULT normal question");
  const imageStorageBefore = await (await context.request.get("/mux/api/note-captures/storage")).json();
  expect(typeof imageStorageBefore.summary.usedBytes).toBe("number");
  await composer.fill("question while reading");
  const sourcePane = execFileSync("tmux", [...tmux, "list-panes", "-t", "=" + source, "-F", "#{pane_id}"], { encoding: "utf8" }).trim();
  execFileSync("tmux", [...tmux, "copy-mode", "-u", "-t", sourcePane]);
  await page.getByRole("button", { name: "Send & keep view", exact: true }).click();
  await expect(held).toBeVisible();
  const image = held.getByRole("img");
  const originalUrl = await image.getAttribute("src");
  expect(originalUrl).toMatch(/^blob:/);
  const pixels = () => image.evaluate(async (element) => {
    const bytes = await (await fetch((element as HTMLImageElement).src)).arrayBuffer();
    return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))).join(",");
  });
  const frozenHash = await pixels();
  await expect(held.getByRole("status")).toContainText("Working");
  await expect(twin.locator(".xterm-rows")).toContainText("RESULT question while reading");
  await expect(held.getByRole("status")).toContainText("Ready");
  await expect(twin.getByRole("region", { name: "Held terminal view" })).toHaveCount(0);
  expect(await pixels()).toBe(frozenHash);
  await expect(page.locator(".held-terminal-live")).toHaveAttribute("inert", "");
  // Frozen content cannot silently type into the live agent.
  await image.click();
  await page.keyboard.type("DO_NOT_SEND_FROM_SNAPSHOT");
  await composer.fill("another question");
  await page.getByRole("button", { name: "Send + Enter", exact: true }).click();
  await expect(twin.locator(".xterm-rows")).toContainText("RESULT another question");
  expect(await image.getAttribute("src")).toBe(originalUrl);
  expect(await pixels()).toBe(frozenHash);
  const attention = async () => {
    const inventory = await (await context.request.get("/mux/api/sessions")).json();
    return inventory.sessions.find((item: { name: string }) => item.name === source).readyAttention;
  };
  await expect.poll(async () => { const row = await attention(); return row.latestReadyEvent > row.lastCheckedEvent; }).toBe(true);
  await page.screenshot({ path: info.outputPath("held-view-dark.png") });
  await held.getByRole("button", { name: "Back to live" }).click();
  await expect(held).toHaveCount(0);
  await expect.poll(async () => { const row = await attention(); return row.latestReadyEvent === row.lastCheckedEvent; }).toBe(true);
  await expect(page.locator(".xterm-rows")).toContainText("RESULT another question");
  expect(await page.evaluate(async (value) => { try { await fetch(value!); return true; } catch { return false; } }, originalUrl)).toBe(false);

  // Focus uses the same draft/submission path through its floating input.
  await page.getByRole("button", { name: "Enter desktop terminal focus", exact: true }).click();
  await page.getByRole("button", { name: "Show floating staged input", exact: true }).click();
  const floating = page.locator(".floating-staged-input-panel");
  await floating.getByRole("textbox", { name: "Floating staged input", exact: true }).fill("focus question");
  await floating.getByRole("button", { name: "Send & keep view" }).click();
  await expect(held).toBeVisible();
  await expect(twin.locator(".xterm-rows")).toContainText("RESULT focus question");
  await expect(floating.getByRole("textbox")).toHaveValue("");
  await page.evaluate(() => window.dispatchEvent(new Event("muxdeck:toggle-theme")));
  await page.screenshot({ path: info.outputPath("held-view-focus-light.png") });
  await held.getByRole("button", { name: "Back to live" }).click();
  await expect(held).toHaveCount(0);
  await floating.getByRole("textbox").fill("keep while switching");
  await floating.getByRole("button", { name: "Send & keep view" }).click();
  await expect(held).toBeVisible();
  await floating.getByRole("button", { name: "Close floating staged input" }).click();
  await page.getByRole("button", { name: "Exit desktop terminal focus", exact: true }).click();
  await page.getByRole("tab", { name: new RegExp(other) }).click();
  await expect(held).toHaveCount(0);
  await expect(page.locator(".xterm-rows")).toContainText("OTHER SESSION");
  const imageStorageAfter = await (await context.request.get("/mux/api/note-captures/storage")).json();
  expect(imageStorageAfter.summary.usedBytes).toBe(imageStorageBefore.summary.usedBytes);
  await twin.close();
});
