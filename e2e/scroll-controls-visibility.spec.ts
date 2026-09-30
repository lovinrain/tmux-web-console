import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, expect } from "@playwright/test";
import { E2E_AUTH_PASSWORD, E2E_AUTH_USERNAME } from "./authFixture";

const socket = process.env.MUXDECK_PLAYWRIGHT_TMUX_SOCKET;
if (!socket?.startsWith("muxdeck-playwright-")) {
  throw new Error("Visibility checks require the disposable Playwright socket");
}
const tmux = ["-L", socket];
const session = `muxdeck-visible-controls-${process.pid}`;
const codexSession = `${session}-codex`;
const directory = mkdtempSync(join(tmpdir(), "muxdeck-controls-"));
const codexInputPath = join(directory, "codex-input.bin");
let paneId = "";
let codexPaneId = "";

test.beforeAll(() => {
  const script = join(directory, "scroll_controls_fixture.py");
  writeFileSync(codexInputPath, "");
  // The Codex-named fixture records native input; it is not a real agent.
  writeFileSync(script, `import ctypes, os, select, sys, time, tty
assert ctypes.CDLL(None).prctl(15, sys.argv[1].encode(), 0, 0, 0) == 0
print("Passive " + sys.argv[1] + " layout fixture", flush=True)
if sys.argv[1] == "codex":
    for row in range(100):
        print("Disposable scroll fixture row " + str(row))
    print("DRAFT_SENTINEL_12345", flush=True)
    tty.setraw(0)
    os.write(1, b"\\x1b[?1049h")
    deadline = time.monotonic() + 180
    with open(sys.argv[2], "ab", buffering=0) as recorded:
        while time.monotonic() < deadline:
            if select.select([0], [], [], 0.5)[0]:
                data = os.read(0, 4096)
                if not data:
                    break
                recorded.write(data)
else:
    time.sleep(180)
`);
  for (const [kind, name] of [["claude", session], ["codex", codexSession]]) {
    execFileSync("tmux", [
      ...tmux, "new-session", "-d", "-s", name,
      "bash", "--noprofile", "--norc", "-c", 'exec -a "$1" python3 "$2" "$1" "$3"', "fixture", kind, script, codexInputPath,
    ]);
  }
  paneId = execFileSync("tmux", [...tmux, "list-panes", "-t", `=${session}`, "-F", "#{pane_id}"], { encoding: "utf8" }).trim();
  codexPaneId = execFileSync("tmux", [...tmux, "list-panes", "-t", `=${codexSession}`, "-F", "#{pane_id}"], { encoding: "utf8" }).trim();
});

test.afterAll(() => {
  execFileSync("tmux", [...tmux, "kill-session", "-t", `=${session}`]);
  execFileSync("tmux", [...tmux, "kill-session", "-t", `=${codexSession}`]);
  rmSync(directory, { recursive: true, force: true });
});

for (const viewport of [
  { width: 1366, height: 768, sideTabs: true },
  { width: 1440, height: 900, sideTabs: true },
  { width: 1025, height: 768, sideTabs: true },
  { width: 1366, height: 600, sideTabs: false },
  { width: 390, height: 844, sideTabs: false },
  { width: 320, height: 600, sideTabs: false },
]) {
  test(`scrolling controls start visible at ${viewport.width}px, side tabs=${viewport.sideTabs}`, async ({ context, page }) => {
    expect((await context.request.post("/mux/api/auth/login", {
      data: { username: E2E_AUTH_USERNAME, password: E2E_AUTH_PASSWORD },
    })).ok()).toBe(true);
    await context.addInitScript((sideTabs) => {
      localStorage.setItem("muxdeck-desktop-tab-orientation", sideTabs ? "vertical" : "horizontal");
      // Previous releases learned a family from clicks. It must not override
      // the detected agent's recommendation, even after a reload.
      localStorage.setItem("muxdeck-agent-scroll-preferences", JSON.stringify({ claude: "tmux" }));
    }, viewport.sideTabs);
    await page.setViewportSize(viewport);
    await page.goto(`/mux/session/${session}?tab=${session}`);
    await expect(page.locator(".console-shell")).toHaveAttribute("data-scroll-agent", "claude");
    await expect(page.locator(".console-shell")).toHaveAttribute("data-desktop-tabs", viewport.sideTabs ? "vertical" : "horizontal");
    const mobile = viewport.width <= 640;
    const strip = mobile
      ? page.getByRole("navigation", { name: "Terminal view controls" })
      : page.getByRole("group", { name: "Terminal input shortcuts" });
    // No click/scrollIntoView call here: controls must be discoverable on open.
    for (const name of ["Tmux Page Up", "Tmux Page Down", "Tmux Line Up", "Tmux Line Down", mobile ? "Raw terminal Page Up" : "PgUp", mobile ? "Raw terminal Page Down" : "PgDn", "Application Scroll Up", "Application Scroll Down"]) {
      const button = strip.getByRole("button", { name, exact: true });
      if (!mobile) await expect(button).toBeInViewport({ ratio: 1 });
      // In particular, the phone CSS must not hide the new SVG-only controls.
      if (name.startsWith("Tmux")) {
        await expect(button.locator(".scroll-context-icon")).toBeVisible();
      } else {
        await expect(button.locator(".scroll-context-icon")).toHaveCount(0);
      }
      await expect(button.locator(".scroll-movement-icon")).toBeVisible();
      await expect(button).toHaveAttribute("title", /\S/);
      expect(await button.innerText()).toBe("");
      const box = await button.boundingBox();
      expect(box!.width).toBeGreaterThanOrEqual(44);
      expect(box!.width).toBeLessThanOrEqual(50);
      if (mobile) expect(box!.height).toBeGreaterThanOrEqual(44);
    }
    for (const name of ["Application Scroll Up", "Application Scroll Down"]) {
      await expect(strip.getByRole("button", { name })).toBeInViewport({ ratio: 1 });
    }
    await expect(strip.getByRole("button", { name: "Application Scroll Up" })).toHaveAttribute("data-scroll-preferred", "true");
    if (!mobile) expect(await strip.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: `artifacts/scroll-controls-${viewport.width}-${viewport.sideTabs ? "side" : "top"}.png`, animations: "disabled" });
    const assertRecommendation = async () => {
      for (const name of [mobile ? "Raw terminal Page Up" : "PgUp", mobile ? "Raw terminal Page Down" : "PgDn", "Application Scroll Up", "Application Scroll Down"]) {
        await expect(strip.getByRole("button", { name, exact: true })).toHaveAttribute("data-scroll-preferred", "true");
      }
      for (const name of ["Tmux Page Up", "Tmux Page Down", "Tmux Line Up", "Tmux Line Down"]) {
        await expect(strip.getByRole("button", { name, exact: true })).not.toHaveAttribute("data-scroll-preferred", "true");
      }
    };
    await assertRecommendation();
    for (const name of ["Tmux Page Up", "Tmux Line Up", "Tmux Line Down", "Tmux Page Down"]) {
      await strip.getByRole("button", { name, exact: true }).click();
      await assertRecommendation();
    }
    await strip.getByRole("button", { name: mobile ? "Return to live terminal" : "Focus live terminal input" }).click();
    await expect.poll(() => execFileSync("tmux", [...tmux, "display-message", "-p", "-t", paneId, "#{pane_in_mode}"], { encoding: "utf8" }).trim()).toBe("0");
    await assertRecommendation();
    await page.reload();
    await assertRecommendation();
  });
}

for (const viewport of [{ width: 1366, height: 768 }, { width: 390, height: 844 }]) {
  test(`all eight scrolling buttons stay enabled and deliver native input in Codex at ${viewport.width}px`, async ({ context, page }) => {
    const frames: { type?: string; profile?: string; direction?: string }[] = [];
    page.on("websocket", (websocket) => websocket.on("framesent", ({ payload }) => {
      try { frames.push(JSON.parse(payload.toString())); } catch { /* raw terminal input */ }
    }));
    const input = () => readFileSync(codexInputPath, "utf8");
    const mode = () => execFileSync("tmux", [...tmux, "display-message", "-p", "-t", codexPaneId, "#{pane_in_mode}"], { encoding: "utf8" }).trim();
    expect((await context.request.post("/mux/api/auth/login", {
      data: { username: E2E_AUTH_USERNAME, password: E2E_AUTH_PASSWORD },
    })).ok()).toBe(true);
    await context.addInitScript(() => localStorage.setItem("muxdeck-desktop-tab-orientation", "vertical"));
    await page.setViewportSize(viewport);
    await page.goto(`/mux/session/${codexSession}?tab=${codexSession}`);
    await expect(page.locator(".console-shell")).toHaveAttribute("data-scroll-agent", "codex");
    await expect(page.locator(".console-shell")).toHaveAttribute("data-scroll-mode", "application");
    await expect(page.locator(".connection-badge")).toContainText("Live");
    const mobile = viewport.width <= 640;
    const strip = mobile
      ? page.getByRole("navigation", { name: "Terminal view controls" })
      : page.getByRole("group", { name: "Terminal input shortcuts" });
    await expect(strip.locator(".scroll-control-icons")).toHaveCount(8);
    for (const name of ["Tmux Page Up", "Tmux Page Down", "Tmux Line Up", "Tmux Line Down", mobile ? "Raw terminal Page Up" : "PgUp", mobile ? "Raw terminal Page Down" : "PgDn", "Application Scroll Up", "Application Scroll Down"]) {
      await expect(strip.getByRole("button", { name, exact: true })).toBeInViewport({ ratio: 1 });
      await expect(strip.getByRole("button", { name, exact: true })).toBeEnabled();
    }
    for (const name of ["Application Scroll Up", "Application Scroll Down"]) {
      const button = strip.getByRole("button", { name });
      await expect(button).toHaveAttribute("title", /three rows/);
      await expect(button).toHaveAttribute("data-scroll-preferred", "true");
    }
    await expect(strip.getByRole("button", { name: "Tmux Line Up" })).not.toHaveAttribute("data-scroll-preferred", "true");
    for (const [name, sequence] of [
      [mobile ? "Raw terminal Page Up" : "PgUp", "\x1b[5~"],
      [mobile ? "Raw terminal Page Down" : "PgDn", "\x1b[6~"],
    ]) {
      const before = input().length;
      await strip.getByRole("button", { name, exact: true }).click();
      await expect.poll(() => input().slice(before)).toContain(sequence);
      expect(mode()).toBe("0");
    }
    if (!mobile) {
      const before = input().length;
      await page.keyboard.press("Control+Shift+U");
      await expect.poll(() => input().slice(before)).toContain("\x1b[5~");
      expect(mode()).toBe("0");
    }
    for (const [direction, buttonCode] of [["Up", 64], ["Down", 65]] as const) {
      const before = input().length;
      const button = strip.getByRole("button", { name: `Application Scroll ${direction}` });
      await button.click();
      await expect.poll(() => input().slice(before)).toMatch(new RegExp(`\\x1b\\[<${buttonCode};[0-9]+;[0-9]+M`));
      await expect(button).toBeEnabled();
      expect(mode()).toBe("0");
    }
    await strip.getByRole("button", { name: "Tmux Line Up" }).click();
    await expect.poll(mode).toBe("1");
    await strip.getByRole("button", { name: "Application Scroll Up" }).click();
    await expect.poll(mode).toBe("0");
    await expect(strip.getByRole("button", { name: "Application Scroll Up" })).toBeEnabled();
    expect(frames.filter((frame) => frame.type === "applicationScroll").map(({ profile, direction }) => ({ profile, direction })))
      .toEqual([{ profile: "codex", direction: "up" }, { profile: "codex", direction: "down" }, { profile: "codex", direction: "up" }]);
    await page.screenshot({ path: `artifacts/all-eight-controls-codex-${viewport.width}.png`, animations: "disabled" });
  });
}
