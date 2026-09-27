import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { E2E_AUTH_PASSWORD, E2E_AUTH_USERNAME } from "./authFixture";

const socketName = process.env.MUXDECK_PLAYWRIGHT_TMUX_SOCKET;
const historyFile = process.env.MUXDECK_PLAYWRIGHT_CLAUDE_HISTORY_FILE;
const transcriptsDirectory = process.env.MUXDECK_PLAYWRIGHT_TRANSCRIPTS_DIR;
if (!socketName?.startsWith("muxdeck-playwright-") || !historyFile?.startsWith("/tmp/muxdeck-playwright-") || !transcriptsDirectory?.startsWith("/tmp/muxdeck-playwright-")) {
  throw new Error("Submitted-message checks require isolated tmux and native history fixtures");
}
const tmux = ["-L", socketName];
const fixtureDirectory = mkdtempSync(join(tmpdir(), "muxdeck-submitted-fixture-"));
const fakeClaude = join(fixtureDirectory, "claude");

test.beforeAll(() => {
  // This local line editor writes the same submitted-input schema as Claude.
  // It makes no model requests and uses only the disposable tmux socket.
  writeFileSync(fakeClaude, `#!/usr/bin/python3
import ctypes, json, pathlib, readline, sys, time
ctypes.CDLL(None).prctl(15, b'claude', 0, 0, 0)
identifier = sys.argv[sys.argv.index('--session-id') + 1]
history = sys.argv[-2]
transcript = pathlib.Path(sys.argv[-1]) / 'claude' / '-fixture' / (identifier + '.jsonl')
transcript.parent.mkdir(parents=True, exist_ok=True)
def record(role, text):
    with transcript.open('a') as target:
        target.write(json.dumps({'type': role, 'sessionId': identifier, 'message': {'role': role, 'content': text}}) + '\\n')
record('user', 'A request from before terminal recording began')
record('assistant', 'An older Claude answer preserved in the local transcript')
print('\\033]2;Claude Code\\007', end='', flush=True)
print('Opening context for ' + identifier, flush=True)
while True:
    try:
        message = input('fixture> ')
    except EOFError:
        break
    with open(history, 'a') as target:
        target.write(json.dumps({'sessionId': identifier, 'timestamp': int(time.time() * 1000), 'display': message, 'pastedContents': {}}) + '\\n')
    record('user', message)
    record('assistant', 'Recorded answer to: ' + message)
    print('\\033[2J\\033[H', end='', flush=True)
    if message.startswith('Middle request'):
        for index in range(3000):
            print('Output row ' + str(index))
    print('Ready for another message', flush=True)
`, { mode: 0o700 });
  writeFileSync(historyFile, "");
});

test.afterAll(() => {
  rmSync(fixtureDirectory, { recursive: true, force: true });
});

for (const width of [1440, 390]) {
  test(`beginning, recent output, and edited input survive cleared scrollback at ${width}px`, async ({ page, context }) => {
    await page.setViewportSize({ width, height: 900 });
    if (width === 390) await context.addInitScript(() => localStorage.setItem("muxdeck-theme", "light"));
    const name = `submitted-${width}-${process.pid}`;
    const identifier = randomUUID();
    execFileSync("tmux", [...tmux, "new-session", "-d", "-s", name,
      "bash", "-c", 'exec -a claude /usr/bin/python3 "$@"', "fixture", fakeClaude, "--session-id", identifier, historyFile, transcriptsDirectory]);
    const pane = execFileSync("tmux", [...tmux, "list-panes", "-t", `=${name}`, "-F", "#{pane_id}"], { encoding: "utf8" }).trim();
    const finalText = `The final edited request for ${width}px`;
    const middleText = `Middle request to keep for ${width}px`;
    let ended = false;
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
      const savedUrl = `/mux/api/panes/${encodeURIComponent(pane)}/saved-scrollback`;
      const beginning = await context.request.get(savedUrl);
      expect(beginning.ok()).toBe(true);
      expect((await beginning.json()).lines.join("\n")).toContain(`Opening context for ${identifier}`);

      // Type and edit directly in the terminal, outside Muxdeck's composer.
      execFileSync("tmux", [...tmux, "send-keys", "-t", pane, "-l", "A draft that must be replaced"]);
      await page.getByRole("button", { name: "Pane scrollback" }).click();
      await expect(page.getByRole("tab", { name: "Transcript", exact: true })).toHaveAttribute("aria-selected", "true");
      await expect(page.getByText("An older Claude answer preserved in the local transcript")).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await page.screenshot({ path: `artifacts/claude-transcript-${width}.png`, animations: "disabled" });
      await page.keyboard.press("Escape");
      await expect(page.getByRole("dialog", { name: "Tmux pane history" })).not.toBeVisible();
      expect(execFileSync("tmux", [...tmux, "capture-pane", "-p", "-t", pane], { encoding: "utf8" })).toContain("A draft that must be replaced");
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

      // Fill and roll tmux's retained buffer. Both submitted inputs stay in the
      // independent archive even though their echoed rows have disappeared.
      execFileSync("tmux", [...tmux, "send-keys", "-t", pane, "-l", middleText]);
      execFileSync("tmux", [...tmux, "send-keys", "-t", pane, "Enter"]);
      await expect.poll(() => submitted().map((record) => record.display)).toEqual([finalText, middleText]);
      await expect.poll(() => execFileSync("tmux", [...tmux, "capture-pane", "-p", "-t", pane], { encoding: "utf8" }))
        .toContain("Output row 2999");
      const recent = await context.request.get(`${savedUrl}?part=recent`);
      expect(recent.ok()).toBe(true);
      const recentOutput = await recent.json();
      expect(recentOutput.lines.length).toBeLessThanOrEqual(2000);
      expect(recentOutput.lines.join("\n")).toContain("Output row 2999");
      expect(recentOutput.lines.join("\n")).not.toContain(`Opening context for ${identifier}`);

      await page.getByRole("tab", { name: "Recorded output" }).click();
      await expect(page.getByLabel("Beginning output", { exact: true })).toContainText(`Opening context for ${identifier}`);
      await expect(page.locator(".saved-scrollback")).toContainText("Recording began");
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await page.screenshot({ path: `artifacts/saved-beginning-${width}.png`, animations: "disabled" });
      await page.getByRole("tab", { name: "Submitted messages" }).click();
      await expect(page.locator(".submitted-message pre")).toHaveText([middleText, finalText]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await page.screenshot({ path: `artifacts/submitted-messages-${width}.png`, animations: "disabled" });
      await page.reload();
      await page.getByRole("button", { name: "Pane scrollback" }).click();
      await page.getByRole("tab", { name: "Submitted messages" }).click();
      await expect(page.locator(".submitted-message pre")).toHaveText([middleText, finalText]);
      expect(submitted()).toHaveLength(2);

      if (width === 1440) {
        const inventory = await context.request.get("/mux/api/sessions");
        const session = (await inventory.json()).sessions.find((item: { name: string }) => item.name === name);
        const terminated = await context.request.delete(`/mux/api/sessions/${name}`, { data: {
          sessionId: session.id, sessionCreated: session.created, serverStarted: session.serverStarted, serverPid: session.serverPid,
        } });
        expect(terminated.status()).toBe(204);
        ended = true;
        await page.goto("/mux/");
        await page.getByRole("button", { name: "Session history", exact: true }).click();
        const history = page.getByRole("dialog", { name: "Session history" });
        await history.getByRole("button", { name: `Transcript for ${name}`, exact: true }).click();
        await expect(history.getByText("An older Claude answer preserved in the local transcript")).toBeVisible();
        await expect(history.getByText(finalText, { exact: true })).toBeVisible();
        await history.getByRole("button", { name: `Saved output for ${name}`, exact: true }).click();
        await expect(history.getByLabel("Beginning output", { exact: true })).toContainText(`Opening context for ${identifier}`);
        await history.getByLabel("Output", { exact: true }).selectOption("recent");
        await expect(history.getByLabel("Recent output", { exact: true })).toContainText("Output row 2999");
        await history.getByRole("button", { name: `Submitted messages for ${name}`, exact: true }).click();
        await expect(history.locator(".submitted-message pre")).toHaveText([middleText, finalText]);
        await page.screenshot({ path: "artifacts/saved-ended-session.png", animations: "disabled" });
      }
    } finally {
      await page.close();
      if (!ended) execFileSync("tmux", [...tmux, "kill-session", "-t", `=${name}`]);
      rmSync(join(transcriptsDirectory, "claude", "-fixture", `${identifier}.jsonl`), { force: true });
    }
  });
}
