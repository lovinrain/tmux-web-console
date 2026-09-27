import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { E2E_AUTH_PASSWORD, E2E_AUTH_USERNAME } from "./authFixture";

const socketName = process.env.MUXDECK_PLAYWRIGHT_TMUX_SOCKET;
const historyFile = process.env.MUXDECK_PLAYWRIGHT_CLAUDE_HISTORY_FILE;
if (!socketName?.startsWith("muxdeck-playwright-") || !historyFile?.startsWith("/tmp/muxdeck-playwright-")) {
  throw new Error("Submitted-message checks require isolated tmux and native history fixtures");
}
const tmux = ["-L", socketName];
const fixtureDirectory = mkdtempSync(join(tmpdir(), "muxdeck-submitted-fixture-"));
const fakeClaude = join(fixtureDirectory, "claude");

test.beforeAll(() => {
  // This local line editor writes the same submitted-input schema as Claude.
  // It makes no model requests and uses only the disposable tmux socket.
  writeFileSync(fakeClaude, `#!/usr/bin/python3
import ctypes, json, readline, sys, time
ctypes.CDLL(None).prctl(15, b'claude', 0, 0, 0)
identifier = sys.argv[sys.argv.index('--session-id') + 1]
history = sys.argv[-1]
print('\\033]2;Claude Code\\007', end='', flush=True)
while True:
    try:
        message = input('fixture> ')
    except EOFError:
        break
    with open(history, 'a') as target:
        target.write(json.dumps({'sessionId': identifier, 'timestamp': int(time.time() * 1000), 'display': message, 'pastedContents': {}}) + '\\n')
    print('\\033[2J\\033[HReady for another message', flush=True)
`, { mode: 0o700 });
  writeFileSync(historyFile, "");
});

test.afterAll(() => {
  rmSync(fixtureDirectory, { recursive: true, force: true });
});

for (const width of [1440, 390]) {
  test(`submitted messages survive editing and cleared scrollback at ${width}px`, async ({ page, context }) => {
    await page.setViewportSize({ width, height: 900 });
    if (width === 390) await context.addInitScript(() => localStorage.setItem("muxdeck-theme", "light"));
    const name = `submitted-${width}-${process.pid}`;
    const identifier = randomUUID();
    execFileSync("tmux", [...tmux, "new-session", "-d", "-s", name,
      "bash", "-c", 'exec -a claude /usr/bin/python3 "$@"', "fixture", fakeClaude, "--session-id", identifier, historyFile]);
    const pane = execFileSync("tmux", [...tmux, "list-panes", "-t", `=${name}`, "-F", "#{pane_id}"], { encoding: "utf8" }).trim();
    const finalText = `The final edited request for ${width}px`;
    const submitted = () => readFileSync(historyFile, "utf8").trim().split("\n").filter(Boolean)
      .map((line) => JSON.parse(line) as { sessionId: string; display: string }).filter((record) => record.sessionId === identifier);
    try {
      const login = await context.request.post("/mux/api/auth/login", {
        data: { username: E2E_AUTH_USERNAME, password: E2E_AUTH_PASSWORD },
      });
      expect(login.ok()).toBe(true);
      await page.goto(`/mux/session/${name}`);
      await expect(page.locator(".connection-badge")).toContainText("Live");
      await expect.poll(async () => {
        const response = await context.request.get("/mux/api/sessions");
        return (await response.json()).sessions.find((session: { name: string }) => session.name === name)?.agentSessionId;
      }).toBe(identifier);

      // Type and edit directly in the terminal, outside Muxdeck's composer.
      execFileSync("tmux", [...tmux, "send-keys", "-t", pane, "-l", "A draft that must be replaced"]);
      await page.getByRole("button", { name: "Pane scrollback" }).click();
      await page.getByRole("tab", { name: "Submitted messages" }).click();
      await expect(page.getByText("No submitted messages recorded yet.")).toBeVisible();
      expect(submitted()).toHaveLength(0);
      execFileSync("tmux", [...tmux, "send-keys", "-t", pane, "C-u"]);
      execFileSync("tmux", [...tmux, "send-keys", "-t", pane, "-l", finalText]);
      execFileSync("tmux", [...tmux, "send-keys", "-t", pane, "Enter"]);
      await expect.poll(() => submitted().map((record) => record.display)).toEqual([finalText]);
      execFileSync("tmux", [...tmux, "clear-history", "-t", pane]);
      expect(execFileSync("tmux", [...tmux, "capture-pane", "-p", "-S", "-", "-t", pane], { encoding: "utf8" })).not.toContain(finalText);
      await page.getByRole("button", { name: "Refresh submitted messages" }).click();
      await expect(page.locator(".submitted-message pre")).toHaveText(finalText);
      await expect(page.locator(".submitted-messages")).not.toContainText("A draft that must be replaced");
      await expect(page.getByRole("button", { name: "Copy message" })).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await page.screenshot({ path: `artifacts/submitted-messages-${width}.png`, animations: "disabled" });
      await page.reload();
      await page.getByRole("button", { name: "Pane scrollback" }).click();
      await page.getByRole("tab", { name: "Submitted messages" }).click();
      await expect(page.locator(".submitted-message pre")).toHaveText(finalText);
      expect(submitted()).toHaveLength(1);
    } finally {
      await page.close();
      execFileSync("tmux", [...tmux, "kill-session", "-t", `=${name}`]);
    }
  });
}
