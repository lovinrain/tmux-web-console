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

// Codex caches these fills. Sent messages can use a different shade from the
// composer; both keep the same terminal bytes after a browser theme toggle.
const fixture = `import ctypes, os, select, signal, sys, termios, tty
kind, color, recording = sys.argv[1:]
history_color = {'48;5;235': '48;5;236', '48;2;240;240;235': '48;2;245;245;240'}[color]
assert ctypes.CDLL(None).prctl(15, kind.encode(), 0, 0, 0) == 0
tty.setraw(sys.stdin.fileno())
dirty = True
submitted = False
def resize(*args):
    global dirty
    dirty = True
signal.signal(signal.SIGWINCH, resize)
with open(recording, 'wb', buffering=0) as captured:
    while True:
        if dirty:
            dirty = False
            cols, rows = os.get_terminal_size()
            top = max(12, rows - 6)
            output = '\\x1b[0m\\x1b[2J\\x1b[H'
            def row(y, text, background):
                return f'\\x1b[{y};1H\\x1b[39;{background}m' + text.ljust(cols) + '\\x1b[0m'
            output += row(2, '› HISTORICAL_PROMPT', history_color)
            output += row(3, '  HISTORICAL_CONTINUATION', history_color)
            output += row(4, 'COLORED_BLOCK', '48;2;120;20;40')
            output += row(5, 'NEUTRAL_OUTPUT', color)
            if submitted:
                output += row(7, '› SUBMITTED_PROMPT', history_color)
                output += row(8, '  SUBMITTED_CONTINUATION', history_color)
            output += row(top, '', color)
            output += row(top + 1, '› MUXDECK_THEME_DRAFT', color)
            output += row(top + 2, '  second draft line', color)
            output += row(top + 3, '', color)
            output += f'\\x1b[{top - 1};1H\\x1b[?25l' if submitted else f'\\x1b[{top + 2};20H\\x1b[?25h'
            sys.stdout.write(output)
            sys.stdout.flush()
        ready, _, _ = select.select([sys.stdin], [], [], .05)
        if ready:
            data = os.read(sys.stdin.fileno(), 4096)
            if not data: break
            captured.write(data)
            if b'\\r' in data:
                submitted = True
                dirty = True
`;

async function backgrounds(page: Page, text: string) {
  return page.locator(".xterm-rows > div").filter({ hasText: text }).evaluate((row) =>
    [...new Set(Array.from(row.children, (cell) => getComputedStyle(cell).backgroundColor)
      .filter((color) => color !== "rgba(0, 0, 0, 0)"))],
  );
}

for (const scenario of [
  { name: "indexed-dark", color: "48;5;235", start: "dark", width: 1366 },
  { name: "rgb-light", color: "48;2;240;240;235", start: "light", width: 390 },
] as const) {
  // Unit tests cover the full color mapping; these retain indexed/RGB rendering,
  // desktop/mobile wiring, both toggle directions, and the submission transition.
  test(`Codex input and sent messages follow theme: ${scenario.name}`, async ({ context, page }) => {
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
      const codeColors = ["rgb(120, 20, 40)"];
      const neutralColors = [scenario.name === "indexed-dark" ? "rgb(38, 38, 38)" : "rgb(240, 240, 235)"];
      const themedBackgrounds = async (theme: string, submitted: boolean) => {
        const fill = theme === "light" ? "rgb(240, 240, 235)" : "rgb(40, 42, 41)";
        for (const text of [
          "MUXDECK_THEME_DRAFT", "second draft line", "HISTORICAL_PROMPT", "HISTORICAL_CONTINUATION",
          ...(submitted ? ["SUBMITTED_PROMPT", "SUBMITTED_CONTINUATION"] : []),
        ]) {
          await expect.poll(() => backgrounds(page, text), { message: `${text} follows ${theme} theme` }).toEqual([fill]);
        }
        await expect.poll(() => backgrounds(page, "COLORED_BLOCK")).toEqual(codeColors);
        await expect.poll(() => backgrounds(page, "NEUTRAL_OUTPUT")).toEqual(neutralColors);
      };
      for (const submitted of [false, true]) {
        if (submitted) {
          await page.locator(".xterm-helper-textarea").focus();
          await page.keyboard.press("Enter");
          await expect(page.locator(".xterm-rows")).toContainText("SUBMITTED_PROMPT");
        }
        await themedBackgrounds(scenario.start, submitted);
        const before = readFileSync(recording);
        for (const theme of [scenario.start === "dark" ? "light" : "dark", scenario.start]) {
          await page.getByTitle(`Switch to ${theme} theme`, { exact: true }).click();
          await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
          await themedBackgrounds(theme, submitted);
          expect(readFileSync(recording)).toEqual(before);
        }
      }
      // A new terminal frame after resizing must retain the correction.
      await page.setViewportSize({ width: scenario.width + 20, height: 940 });
      await themedBackgrounds(scenario.start, true);
      await page.screenshot({ path: `artifacts/codex-theme-${scenario.name}.png`, animations: "disabled" });
    } finally {
      execFileSync("tmux", [...tmux, "kill-session", "-t", `=${session}`]);
      rmSync(directory, { recursive: true, force: true });
    }
  });
}

test("Copilot distinguishes prompts and completed answers from activity in both themes", async ({ context, page }) => {
  const session = "muxdeck-theme-" + process.pid + "-copilot";
  const fixture = [
    "let settled = false;",
    "function draw() {",
    "  const { columns, rows } = process.stdout;",
    "  const rule = '─'.repeat(columns);",
    "  const framed = (text) => text.padEnd(columns - 1) + '┃';",
    "  const row = (y, text) => '\\x1b[' + y + ';1H' + text;",
    "  const sent = (text) => (' ❯ ' + text).padEnd(columns - 7) + '11:22 ┃';",
    "  const assistant = (text) => framed(' ● ' + text).replace('●', '\\x1b[34m●\\x1b[39m');",
    "  process.stdout.write('\\x1b[0m\\x1b[2J\\x1b[H'",
    "    + row(2, sent('SENT_REQUEST'))",
    "    + row(3, framed('   SENT_CONTINUATION'))",
    "    + row(4, framed(''))",
    "    + row(5, assistant('EARLIER_ANSWER'))",
    "    + row(6, sent('TOOL_REQUEST'))",
    "    + row(7, assistant('TOOL_ONLY_PROGRESS'))",
    "    + row(8, framed(' $ TOOL_ONLY_RESULT'))",
    "    + row(9, sent('INTERRUPTED_REQUEST'))",
    "    + row(10, assistant('INTERRUPTED_PROGRESS'))",
    "    + row(11, '\\x1b[3m' + framed(' ❯ INTERRUPTED_NOTICE') + '\\x1b[0m')",
    "    + row(12, sent('CURRENT_REQUEST'))",
    "    + row(13, assistant('COPILOT_PROGRESS'))",
    "    + row(14, framed('   ❯ QUOTED_PROMPT'.padEnd(columns - 7) + '11:25 '))",
    "    + row(15, framed(' $ TOOL_ACTIVITY'))",
    "    + row(16, assistant('CURRENT_ANSWER'))",
    "    + row(17, framed(''))",
    "    + row(18, framed('   ANSWER_CONTINUATION'))",
    "    + row(rows - 4, '\\x1b[2m' + rule + '\\x1b[0m')",
    "    + row(rows - 3, '❯ EDITABLE_DRAFT')",
    "    + row(rows - 2, '  DRAFT_CONTINUATION')",
    "    + row(rows - 1, '\\x1b[2m' + rule + '\\x1b[0m')",
    "    + row(rows, settled ? '/ commands · ? help · tab next tab' : '◎ Working ctrl+c interrupt')",
    "    + '\\x1b[' + (rows - 2) + ';20H');",
    "}",
    "process.stdout.write('\\x1b[?1049h\\x1b]2;GitHub Copilot\\x07');",
    "process.stdout.on('resize', draw);",
    "process.stdin.setRawMode(true);",
    "process.stdin.on('data', (data) => { if (data.includes(13)) { settled = true; draw(); } });",
    "draw();",
  ].join("\n");
  execFileSync("tmux", [...tmux, "new-session", "-d", "-s", session, "node", "-e", fixture]);
  try {
    expect((await context.request.post("/mux/api/auth/login", {
      data: { username: E2E_AUTH_USERNAME, password: E2E_AUTH_PASSWORD },
    })).ok()).toBe(true);
    await context.addInitScript(() => localStorage.setItem("muxdeck-theme", "dark"));
    await page.setViewportSize({ width: 1366, height: 900 });
    let terminalConnections = 0;
    page.on("websocket", (socket) => {
      if (socket.url().includes("/ws/terminal")) terminalConnections += 1;
    });
    await page.goto("/mux/session/" + session + "?tab=" + session);
    await expect(page.locator(".console-shell")).toHaveAttribute("data-scroll-agent", "copilot");
    await expect(page.locator(".xterm-rows")).toContainText("EDITABLE_DRAFT");
    const prompts = ["SENT_REQUEST", "SENT_CONTINUATION", "EDITABLE_DRAFT", "DRAFT_CONTINUATION"];
    const activity = [
      "COPILOT_PROGRESS", "TOOL_ACTIVITY", "TOOL_ONLY_PROGRESS", "TOOL_ONLY_RESULT",
      "QUOTED_PROMPT", "INTERRUPTED_PROGRESS", "INTERRUPTED_NOTICE",
    ];
    const currentReply = ["CURRENT_ANSWER", "ANSWER_CONTINUATION"];
    const check = async (theme: "dark" | "light", settled: boolean) => {
      const promptFill = theme === "dark" ? "rgb(45, 47, 46)" : "rgb(233, 232, 227)";
      const answerFill = theme === "dark" ? ["rgb(119, 189, 251)", "rgb(27, 40, 47)"]
        : ["rgb(25, 89, 166)", "rgb(223, 230, 235)"];
      for (const text of prompts) {
        await expect.poll(() => backgrounds(page, text), { message: text }).toEqual([promptFill]);
      }
      for (const text of ["EARLIER_ANSWER", ...(settled ? currentReply : [])]) {
        await expect.poll(() => backgrounds(page, text), { message: text }).toEqual(answerFill);
      }
      for (const text of [...activity, ...(settled ? [] : currentReply)]) {
        await expect.poll(() => backgrounds(page, text), { message: text }).toEqual([]);
      }
    };
    await check("dark", false);
    await page.locator(".xterm-helper-textarea").focus();
    await page.keyboard.press("Enter");
    await expect(page.locator(".xterm-rows")).toContainText("/ commands");
    await check("dark", true);
    await page.getByTitle("Switch to light theme", { exact: true }).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    await check("light", true);
    expect(terminalConnections).toBe(1);
  } finally {
    execFileSync("tmux", [...tmux, "kill-session", "-t", "=" + session]);
  }
});
