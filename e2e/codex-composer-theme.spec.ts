import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, expect, type Page } from "@playwright/test";
import { E2E_AUTH_PASSWORD, E2E_AUTH_USERNAME } from "./authFixture";

const socket = process.env.MUXDECK_PLAYWRIGHT_TMUX_SOCKET;
if (!socket?.startsWith("muxdeck-playwright-")) {
  throw new Error("Theme checks require the disposable Playwright socket");
}
const tmux = ["-L", socket];

// The installed Codex 0.157.1 emits these cached composer fills. This fixture
// keeps the same bytes after a browser toggle, just as the real application does.
const fixture = `import ctypes, os, select, signal, sys, termios, tty
kind, color, recording = sys.argv[1:]
assert ctypes.CDLL(None).prctl(15, kind.encode(), 0, 0, 0) == 0
tty.setraw(sys.stdin.fileno())
dirty = True
def resize(*args):
    global dirty
    dirty = True
signal.signal(signal.SIGWINCH, resize)
with open(recording, 'wb', buffering=0) as captured:
    while True:
        if dirty:
            dirty = False
            cols, rows = os.get_terminal_size()
            top = max(6, rows - 6)
            output = '\\x1b[0m\\x1b[2J\\x1b[H'
            def row(y, text, background):
                return f'\\x1b[{y};1H\\x1b[39;{background}m' + text.ljust(cols) + '\\x1b[0m'
            output += row(2, '› HISTORICAL_PROMPT', color)
            output += row(4, 'COLORED_BLOCK', '48;2;120;20;40')
            output += row(top, '', color)
            output += row(top + 1, '› MUXDECK_THEME_DRAFT', color)
            output += row(top + 2, '  second draft line', color)
            output += row(top + 3, '', color)
            output += f'\\x1b[{top + 2};20H\\x1b[?25h'
            sys.stdout.write(output)
            sys.stdout.flush()
        ready, _, _ = select.select([sys.stdin], [], [], .05)
        if ready:
            data = os.read(sys.stdin.fileno(), 4096)
            if not data: break
            captured.write(data)
`;

async function backgrounds(page: Page, text: string) {
  return page.locator(".xterm-rows > div").filter({ hasText: text }).evaluate((row) =>
    [...new Set(Array.from(row.children, (cell) => getComputedStyle(cell).backgroundColor)
      .filter((color) => color !== "rgba(0, 0, 0, 0)"))],
  );
}

for (const scenario of [
  { name: "indexed-dark", color: "48;5;235", start: "dark", width: 1366 },
  { name: "indexed-light", color: "48;5;255", start: "light", width: 390 },
  { name: "rgb-dark", color: "48;2;40;42;41", start: "dark", width: 390 },
  { name: "rgb-light", color: "48;2;240;240;235", start: "light", width: 1366 },
] as const) {
  test(`Codex composer follows theme in both directions: ${scenario.name}`, async ({ context, page }) => {
    const directory = mkdtempSync(join(tmpdir(), "muxdeck-composer-theme-"));
    const session = `muxdeck-theme-${process.pid}-${scenario.name}`;
    const script = join(directory, "fixture.py");
    const recording = join(directory, "input.bin");
    writeFileSync(script, fixture);
    execFileSync("tmux", [
      ...tmux, "new-session", "-d", "-s", session,
      "bash", "--noprofile", "--norc", "-c", 'exec -a codex python3 "$1" codex "$2" "$3"',
      "fixture", script, scenario.color, recording,
    ]);
    try {
      // Preserve truecolor cells through the disposable tmux attach client too.
      execFileSync("tmux", [...tmux, "set-option", "-as", "terminal-features", ",xterm-256color:RGB"]);
      expect((await context.request.post("/mux/api/auth/login", {
        data: { username: E2E_AUTH_USERNAME, password: E2E_AUTH_PASSWORD },
      })).ok()).toBe(true);
      await context.addInitScript((theme) => localStorage.setItem("muxdeck-theme", theme), scenario.start);
      await page.setViewportSize({ width: scenario.width, height: 900 });
      await page.goto(`/mux/session/${session}?tab=${session}`);
      await expect(page.locator(".console-shell")).toHaveAttribute("data-scroll-agent", "codex");
      await expect(page.locator(".connection-badge")).toContainText("Live");
      await expect(page.locator(".xterm-rows")).toContainText("MUXDECK_THEME_DRAFT");
      const historicalColors = await backgrounds(page, "HISTORICAL_PROMPT");
      const codeColors = await backgrounds(page, "COLORED_BLOCK");
      const before = readFileSync(recording);
      for (const theme of [scenario.start === "dark" ? "light" : "dark", scenario.start]) {
        await page.getByTitle(`Switch to ${theme} theme`, { exact: true }).click();
        await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
        const fill = theme === "light" ? "rgb(240, 240, 235)" : "rgb(40, 42, 41)";
        await expect.poll(() => backgrounds(page, "MUXDECK_THEME_DRAFT")).toEqual([fill]);
        await expect.poll(() => backgrounds(page, "second draft line")).toEqual([fill]);
        await expect.poll(() => backgrounds(page, "HISTORICAL_PROMPT")).toEqual(historicalColors);
        await expect.poll(() => backgrounds(page, "COLORED_BLOCK")).toEqual(codeColors);
        expect(readFileSync(recording)).toEqual(before);
      }
      // A new terminal frame after resizing must retain the correction.
      await page.setViewportSize({ width: scenario.width + 20, height: 940 });
      const fill = scenario.start === "light" ? "rgb(240, 240, 235)" : "rgb(40, 42, 41)";
      await expect.poll(() => backgrounds(page, "MUXDECK_THEME_DRAFT")).toEqual([fill]);
      await page.screenshot({ path: `artifacts/codex-theme-${scenario.name}.png`, animations: "disabled" });
    } finally {
      execFileSync("tmux", [...tmux, "kill-session", "-t", `=${session}`]);
      rmSync(directory, { recursive: true, force: true });
    }
  });
}
