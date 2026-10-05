import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, expect } from "@playwright/test";
import { E2E_AUTH_PASSWORD, E2E_AUTH_USERNAME } from "./authFixture";

const socket = process.env.MUXDECK_PLAYWRIGHT_TMUX_SOCKET;
if (!socket?.startsWith("muxdeck-playwright-")) throw new Error("Use the disposable Playwright socket");
const tmux = ["-L", socket];
const session = `muxdeck-held-scroll-${process.pid}`;
const claudeSession = `${session}-claude`;
const directory = mkdtempSync(join(tmpdir(), "muxdeck-held-scroll-"));
const claudeInputPath = join(directory, "claude-input.bin");
let claudePane = "";

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
  const claudeScript = join(directory, "claude_scroll.py");
  // A wheel-aware Claude-named fixture paints its transcript immediately, so
  // continuous scrolling exercises the real acknowledgment path and movement.
  writeFileSync(claudeInputPath, "");
  writeFileSync(claudeScript, `import ctypes, os, re, select, sys, time, tty
assert ctypes.CDLL(None).prctl(15, b"claude", 0, 0, 0) == 0
tty.setraw(0)
os.write(1, b"\\x1b[?1049h\\x1b[?1000h\\x1b[?1006h")
position = 1000
def render():
    row = max(8, os.get_terminal_size().lines - 1)
    os.write(1, (f"\\x1b[H\\x1b[2JClaude scrolling fixture\\x1b[6;1HCLAUDE_POSITION_{position:04d}"
                 f"\\x1b[{row};1HDRAFT_SENTINEL_12345").encode())
render()
pending = b""
deadline = time.monotonic() + 180
with open(sys.argv[1], "ab", buffering=0) as recorded:
    while time.monotonic() < deadline:
        if not select.select([0], [], [], 0.5)[0]:
            continue
        data = os.read(0, 4096)
        if not data:
            break
        recorded.write(data)
        pending += data
        while match := re.search(rb"\\x1b\\[<6[45];[0-9]+;[0-9]+M", pending):
            position += -1 if b"<64;" in match[0] else 1
            pending = pending[match.end():]
            render()
`);
  claudePane = execFileSync("tmux", [...tmux, "new-session", "-d", "-P", "-F", "#{pane_id}", "-s", claudeSession,
    "bash", "--noprofile", "--norc", "-c", 'exec -a claude python3 "$1" "$2"', "fixture", claudeScript, claudeInputPath],
  { encoding: "utf8" }).trim();
});

test.afterAll(() => {
  execFileSync("tmux", [...tmux, "kill-session", "-t", `=${session}`]);
  execFileSync("tmux", [...tmux, "kill-session", "-t", `=${claudeSession}`]);
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
    let pendingLines = 0;
    let maximumPendingLines = 0;
    page.on("websocket", (websocket) => {
      websocket.on("framesent", ({ payload }) => {
        const data = payload.toString();
        try {
          const message = JSON.parse(data);
          if (message.type === "resize") return;
          if (message.type === "history") {
            sent.push(`history:${message.action}`);
            if (message.action === "line-up" || message.action === "line-down") {
              maximumPendingLines = Math.max(maximumPendingLines, ++pendingLines);
            }
          }
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
          if ((message.type === "historyAck" || message.type === "historyNack")
            && (message.action === "line-up" || message.action === "line-down")) pendingLines -= 1;
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
      const continuous = expected.startsWith("history:line-") || expected.startsWith("application:");
      // Fine scrolling must repeat before the old 350 ms hold threshold.
      if (continuous) {
        await expect.poll(() => sent.slice(start).filter((value) => value === expected).length, {
          message: `${name} repeats without a hold delay`, timeout: 300, intervals: [20],
        }).toBeGreaterThanOrEqual(2);
      }
      // Native requests can take longer to acknowledge than tmux line requests.
      await expect.poll(() => sent.slice(start).filter((value) => value === expected).length, {
        message: `${name} keeps scrolling while held`, intervals: [20],
      }).toBeGreaterThanOrEqual(3);
      await page.mouse.up();
      const stoppedAt = sent.length;
      // An observation window is necessary to prove that release stops repeats.
      await page.waitForTimeout(300);
      expect(sent.length).toBe(stoppedAt);
      expect(sent.slice(start).every((value) => value === expected)).toBe(true);
    }
    expect(maximumPending).toBe(1);
    expect(maximumPendingLines).toBe(1);
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

for (const width of [1440, 390]) {
  test(`holding Claude application arrows moves its transcript and stops at ${width}px`, async ({ page }) => {
    const sent: string[] = [];
    const profiles: string[] = [];
    const rejected: unknown[] = [];
    const pending = new Set<string>();
    let maximumPending = 0;
    page.on("websocket", (websocket) => {
      websocket.on("framesent", ({ payload }) => {
        try {
          const message = JSON.parse(payload.toString());
          if (message.type === "applicationScroll") {
            profiles.push(message.profile);
            sent.push(message.direction);
            pending.add(message.id);
            maximumPending = Math.max(maximumPending, pending.size);
          }
        } catch { /* raw terminal input */ }
      });
      websocket.on("framereceived", ({ payload }) => {
        try {
          const message = JSON.parse(payload.toString());
          if (message.type === "applicationScrollNack") rejected.push(message);
          if (message.type === "applicationScrollAck" || message.type === "applicationScrollNack") pending.delete(message.id);
        } catch { /* terminal output */ }
      });
    });
    const capture = () => execFileSync("tmux", [...tmux, "capture-pane", "-p", "-t", claudePane], { encoding: "utf8" });
    const position = () => Number(capture().match(/CLAUDE_POSITION_(\d+)/)?.[1] ?? -1);
    const inputStart = readFileSync(claudeInputPath, "utf8").length;
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`/mux/session/${claudeSession}?tab=${claudeSession}`);
    await expect(page.locator(".connection-badge")).toContainText("Live");
    await expect(page.locator(".console-shell")).toHaveAttribute("data-scroll-agent", "claude");
    const mobile = width < 640;
    const controls = mobile
      ? page.getByRole("navigation", { name: "Terminal view controls" })
      : page.getByRole("group", { name: "Terminal input shortcuts" });
    if (!mobile) await page.getByRole("textbox", { name: "Staged input" }).fill("keep this unsent draft");
    for (const direction of ["up", "down"]) {
      const before = position();
      expect(before).toBeGreaterThan(0);
      const start = sent.length;
      const button = controls.getByRole("button", { name: `Application Scroll ${direction === "up" ? "Up" : "Down"}` });
      await button.hover();
      await page.mouse.down();
      await expect.poll(() => sent.length - start, { intervals: [20] }).toBeGreaterThanOrEqual(4);
      await page.mouse.up();
      const stoppedAt = sent.length;
      await expect.poll(() => pending.size, { intervals: [20] }).toBe(0);
      await page.waitForTimeout(300);
      expect(sent.length).toBe(stoppedAt);
      expect(sent.slice(start).every((value) => value === direction)).toBe(true);
      if (direction === "up") expect(position()).toBeLessThan(before);
      else expect(position()).toBeGreaterThan(before);
      expect(capture()).toContain("DRAFT_SENTINEL_12345");
      if (!mobile) await expect(page.getByRole("textbox", { name: "Staged input" })).toHaveValue("keep this unsent draft");
    }
    expect(maximumPending).toBe(1);
    expect(new Set(profiles)).toEqual(new Set(["claude"]));
    expect(rejected).toEqual([]);
    // Only native wheel packets reach the fixture; no draft editing or Enter.
    expect(readFileSync(claudeInputPath, "utf8").slice(inputStart).replace(/\x1b\[<6[45];[0-9]+;[0-9]+M/g, "")).toBe("");
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
