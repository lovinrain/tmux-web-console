import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { E2E_AUTH_PASSWORD, E2E_AUTH_USERNAME } from "./authFixture";

const socketName = process.env.MUXDECK_PLAYWRIGHT_TMUX_SOCKET;
const transcriptsDirectory = process.env.MUXDECK_PLAYWRIGHT_TRANSCRIPTS_DIR;
if (!socketName?.startsWith("muxdeck-playwright-") || !transcriptsDirectory?.startsWith("/tmp/muxdeck-playwright-")) {
  throw new Error("Transcript checks require isolated tmux and native storage fixtures");
}
const tmux = ["-L", socketName];

test("Codex transcript recovers messages hidden behind the full-transcript placeholder", async ({ page, context }) => {
  const directory = mkdtempSync(join(tmpdir(), "muxdeck-transcript-fixture-"));
  const identifier = randomUUID();
  const name = `transcript-${process.pid}`;
  const fakeCodex = join(directory, "codex");
  const nativeDirectory = join(transcriptsDirectory, "codex", "sessions", "2026", "09", "26");
  const transcript = join(nativeDirectory, `rollout-2026-09-26T12-00-00-${identifier}.jsonl`);
  mkdirSync(nativeDirectory, { recursive: true });
  const message = (text: string, role = "assistant") => ({ type: "response_item", payload: {
    type: "message", role, content: [{ type: "output_text", text }],
  } });
  const records = [{ type: "session_meta", payload: { id: identifier, source: "cli" } },
    message("The original request before the terminal buffer", "user"),
    ...Array.from({ length: 52 }, (_, index) => message(`Saved answer ${index + 1}`))];
  writeFileSync(transcript, records.map((record) => JSON.stringify(record)).join("\n") + "\n");
  writeFileSync(fakeCodex, `#!/usr/bin/python3
import ctypes, time
ctypes.CDLL(None).prctl(15, b'codex', 0, 0, 0)
print('Earlier messages are available — press ctrl+t to view the full transcript', flush=True)
while True:
    time.sleep(1)
`, { mode: 0o700 });
  execFileSync("tmux", [...tmux, "new-session", "-d", "-s", name,
    "bash", "-c", 'exec -a codex /usr/bin/python3 "$@"', "fixture", fakeCodex, "--session-id", identifier]);
  try {
    await page.setViewportSize({ width: 1440, height: 900 });
    expect((await context.request.post("/mux/api/auth/login", { data: { username: E2E_AUTH_USERNAME, password: E2E_AUTH_PASSWORD } })).ok()).toBe(true);
    await page.goto(`/mux/session/${name}`);
    await expect(page.locator(".connection-badge")).toContainText("Live");
    await page.getByRole("button", { name: "Pane scrollback" }).click();
    await expect(page.getByRole("tab", { name: "Transcript", exact: true })).toHaveAttribute("aria-selected", "true");
    await expect(page.getByText("The original request before the terminal buffer")).toBeVisible();
    await expect(page.locator(".agent-transcript")).not.toContainText("Earlier messages are available");
    await page.getByRole("button", { name: "Load later messages" }).click();
    await expect(page.getByText("Saved answer 52", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Copy loaded transcript" })).toBeEnabled();
    await page.screenshot({ path: "artifacts/codex-local-transcript.png", animations: "disabled" });
    await page.getByRole("tab", { name: "Scrollback", exact: true }).click();
    await expect(page.locator(".history-scroll")).toContainText("Earlier messages are available");
    await page.getByRole("button", { name: "Read the local agent transcript" }).click();
    await expect(page.getByText("The original request before the terminal buffer")).toBeVisible();
    rmSync(transcript);
    await page.getByRole("button", { name: "Refresh transcript" }).click();
    await expect(page.getByText(/local transcript was not found/)).toBeVisible();
    await page.getByRole("button", { name: "Terminal scrollback", exact: true }).click();
    await expect(page.locator(".history-scroll")).toContainText("Earlier messages are available");
  } finally {
    await page.close();
    execFileSync("tmux", [...tmux, "kill-session", "-t", `=${name}`]);
    rmSync(directory, { recursive: true, force: true });
    rmSync(transcript, { force: true });
  }
});
