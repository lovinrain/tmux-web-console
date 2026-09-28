import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, expect } from "@playwright/test";
import { E2E_AUTH_PASSWORD, E2E_AUTH_USERNAME } from "./authFixture";

const socket = process.env.MUXDECK_PLAYWRIGHT_TMUX_SOCKET;
if (!socket?.startsWith("muxdeck-playwright-")) throw new Error("Use the disposable Playwright socket");
const tmux = ["-L", socket];
const session = `muxdeck-held-scroll-${process.pid}`;
const directory = mkdtempSync(join(tmpdir(), "muxdeck-held-scroll-"));

test.beforeAll(() => {
  const script = join(directory, "native_scroll.py");
  // A passive Codex-named terminal fixture, not a coding agent. It accepts native
  // wheel input while tmux retains enough initial output to exercise history.
  writeFileSync(script, `import ctypes, os, select, time, tty
assert ctypes.CDLL(None).prctl(15, b"codex", 0, 0, 0) == 0
for row in range(400):
    print("Held scroll fixture row " + str(row))
print("DRAFT_SENTINEL", flush=True)
tty.setraw(0)
os.write(1, b"\\x1b[?1049h")
deadline = time.monotonic() + 180
while time.monotonic() < deadline:
    if select.select([0], [], [], 0.5)[0] and not os.read(0, 4096):
        break
`);
  execFileSync("tmux", [...tmux, "new-session", "-d", "-s", session,
    "bash", "--noprofile", "--norc", "-c", 'exec -a codex python3 "$1"', "fixture", script]);
});

test.afterAll(() => {
  execFileSync("tmux", [...tmux, "kill-session", "-t", `=${session}`]);
  rmSync(directory, { recursive: true, force: true });
});

test.beforeEach(async ({ context }) => {
  expect((await context.request.post("/mux/api/auth/login", {
    data: { username: E2E_AUTH_USERNAME, password: E2E_AUTH_PASSWORD },
  })).ok()).toBe(true);
});

for (const width of [1440, 390]) {
  test(`holding all eight scrolling controls repeats and stops at ${width}px`, async ({ page }) => {
    const sent: string[] = [];
    const nativePending = new Set<string>();
    let maximumPending = 0;
    page.on("websocket", (websocket) => {
      websocket.on("framesent", ({ payload }) => {
        const data = payload.toString();
        try {
          const message = JSON.parse(data);
          if (message.type === "resize") return;
          if (message.type === "history") sent.push(`history:${message.action}`);
          if (message.type === "applicationScroll") {
            sent.push(`application:${message.direction}`);
            nativePending.add(message.id);
            maximumPending = Math.max(maximumPending, nativePending.size);
          }
        } catch { sent.push(data); }
      });
      websocket.on("framereceived", ({ payload }) => {
        try {
          const message = JSON.parse(payload.toString());
          if (message.type === "applicationScrollAck" || message.type === "applicationScrollNack") nativePending.delete(message.id);
        } catch { /* terminal output */ }
      });
    });
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`/mux/session/${session}?tab=${session}`);
    await expect(page.locator(".connection-badge")).toContainText("Live");
    const mobile = width < 640;
    const controls = mobile
      ? page.getByRole("navigation", { name: "Terminal view controls" })
      : page.getByRole("group", { name: "Terminal input shortcuts" });
    const live = controls.getByRole("button", { name: mobile ? "Return to live terminal" : "Focus live terminal input" });
    const actions = [
      ["Tmux Page Up", mobile ? "history:page-up" : "\x02\x1b[5~"],
      ["Tmux Page Down", mobile ? "history:page-down" : "\x1b[6~"],
      ["Tmux Line Up", "history:line-up"], ["Tmux Line Down", "history:line-down"],
      [mobile ? "Raw terminal Page Up" : "PgUp", "\x1b[5~"],
      [mobile ? "Raw terminal Page Down" : "PgDn", "\x1b[6~"],
      ["Application Scroll Up", "application:up"], ["Application Scroll Down", "application:down"],
    ];
    for (const [name, expected] of actions) {
      await live.click();
      if (name.endsWith("Down") && name.startsWith("Tmux")) {
        await controls.getByRole("button", { name: "Tmux Page Up", exact: true }).click();
      }
      const button = controls.getByRole("button", { name, exact: true });
      await button.hover();
      const start = sent.length;
      await page.mouse.down();
      await expect.poll(() => sent.slice(start).filter((value) => value === expected).length).toBeGreaterThanOrEqual(3);
      await page.mouse.up();
      const stoppedAt = sent.length;
      // An observation window is necessary to prove that release stops repeats.
      await page.waitForTimeout(300);
      expect(sent.length).toBe(stoppedAt);
      expect(sent.slice(start).every((value) => value === expected)).toBe(true);
    }
    expect(maximumPending).toBe(1);
    const pageUp = controls.getByRole("button", { name: mobile ? "Raw terminal Page Up" : "PgUp", exact: true });
    await pageUp.hover();
    await page.mouse.down();
    await page.mouse.move(width - 10, 10);
    const stoppedAt = sent.length;
    await page.waitForTimeout(450);
    await page.mouse.up();
    expect(sent.length).toBe(stoppedAt);
  });
}

test("Scrollback opens from its shortcut and command search, including Focus", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/mux/session/${session}?tab=${session}`);
  await expect(page.locator(".connection-badge")).toContainText("Live");
  const button = page.getByRole("button", { name: "Pane scrollback" });
  await expect(button).toHaveAttribute("aria-keyshortcuts", "Control+Shift+P");
  const draft = page.getByRole("textbox", { name: "Staged input" });
  await draft.fill("keep this unsent draft");
  const input: string[] = [];
  // Count terminal sends only while triggering shortcuts, after attachment.
  await page.evaluate(() => {
    const nativeSend = WebSocket.prototype.send;
    const values: string[] = [];
    (window as Window & { shortcutFrames?: string[] }).shortcutFrames = values;
    WebSocket.prototype.send = function (data) {
      if (this.url.includes("/ws/terminal") && !(typeof data === "string" && data.includes('"type":"resize"'))) values.push(String(data));
      return nativeSend.call(this, data);
    };
  });
  await page.keyboard.press("Control+Shift+P");
  const history = page.getByRole("dialog", { name: "Tmux pane history" });
  await expect(history).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(history).toBeHidden();
  await expect(draft).toHaveValue("keep this unsent draft");
  await page.keyboard.press("Control+Shift+H");
  const palette = page.getByRole("dialog", { name: "Run a command" });
  await palette.getByRole("combobox", { name: "Search commands" }).fill("open scrollback");
  await expect(palette.locator('[role="option"][aria-selected="true"] strong')).toHaveText("Open scrollback");
  await page.keyboard.press("Enter");
  await expect(history).toBeVisible();
  await page.keyboard.press("Escape");
  await page.keyboard.press("Control+Shift+F");
  await page.keyboard.press("Control+Shift+P");
  await expect(history).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator(".console-shell")).toHaveAttribute("data-desktop-focus", "true");
  input.push(...await page.evaluate(() => (window as Window & { shortcutFrames: string[] }).shortcutFrames));
  expect(input).toEqual([]);
});
