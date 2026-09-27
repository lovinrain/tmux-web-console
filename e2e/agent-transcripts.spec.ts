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

test("Saved beginning finds the first Codex prompt through launchers and separates replies from activity", async ({ page, context }, testInfo) => {
  const directory = mkdtempSync(join(tmpdir(), "muxdeck-transcript-fixture-"));
  const identifier = randomUUID();
  const name = `transcript-${process.pid}`;
  const fakeCodex = join(directory, "codex");
  const launcher = join(directory, "launcher.py");
  const nativeDirectory = join(transcriptsDirectory, "codex", "sessions", "2026", "09", "26");
  const transcript = join(nativeDirectory, `rollout-2026-09-26T12-00-00-${identifier}.jsonl`);
  mkdirSync(nativeDirectory, { recursive: true });
  const message = (text: string, role = "assistant", phase = "final_answer") => ({ type: "response_item", payload: {
    type: "message", role, phase: role === "assistant" ? phase : undefined,
    content: [{ type: role === "user" ? "input_text" : "output_text", text }],
  } });
  const records = [{ type: "session_meta", payload: { id: identifier, source: "cli" } },
    // A scan window of metadata must not strand the reader before the prompt.
    ...Array.from({ length: 5005 }, () => ({ type: "event_msg", payload: { type: "token_count" } })),
    message("<environment_context>Injected setup, not the user's prompt</environment_context>", "user"),
    message("The original request before the terminal buffer", "user"),
    message("Checking files in a progress update", "assistant", "commentary"),
    { type: "response_item", payload: { type: "function_call_output", output: "Detailed tool output" } },
    ...Array.from({ length: 52 }, (_, index) => message(`Saved answer ${index + 1}`))];
  writeFileSync(transcript, records.map((record) => JSON.stringify(record)).join("\n") + "\n");
  writeFileSync(fakeCodex, `#!/usr/bin/python3
import ctypes, sys, time
ctypes.CDLL(None).prctl(15, b'codex', 0, 0, 0)
rollout = open(sys.argv[1], 'rb')
print('Earlier messages are available — press ctrl+t to view the full transcript', flush=True)
while True:
    time.sleep(1)
`, { mode: 0o700 });
  // Like Volta, argv[0] names the agent but this process is only its launcher.
  // Its stale resume argument must not supersede the child's current rollout.
  writeFileSync(launcher, `import ctypes, subprocess, sys
ctypes.CDLL(None).prctl(15, b'codex', 0, 0, 0)
subprocess.run(['codex', sys.argv[1], sys.argv[2]], executable='/usr/bin/python3')
`);
  execFileSync("tmux", [...tmux, "new-session", "-d", "-s", name,
    "bash", "-c", 'exec -a codex /usr/bin/python3 "$@"', "fixture", launcher, fakeCodex, transcript, "--resume", randomUUID()]);
  try {
    await page.setViewportSize({ width: 1440, height: 900 });
    expect((await context.request.post("/mux/api/auth/login", { data: { username: E2E_AUTH_USERNAME, password: E2E_AUTH_PASSWORD } })).ok()).toBe(true);
    await page.goto(`/mux/session/${name}`);
    await expect(page.locator(".connection-badge")).toContainText("Live");
    await page.getByRole("button", { name: "Pane scrollback" }).click();
    await expect(page.getByRole("tab", { name: "Transcript", exact: true })).toHaveAttribute("aria-selected", "true");
    await expect(page.getByText("The original request before the terminal buffer")).toBeVisible();
    await expect(page.locator(".agent-transcript")).not.toContainText("Earlier messages are available");
    await expect(page.locator(".agent-transcript")).not.toContainText("Injected setup");
    await expect(page.locator(".agent-transcript")).not.toContainText("Checking files in a progress update");
    await page.getByRole("button", { name: "Load later messages" }).click();
    await page.getByRole("button", { name: "Latest loaded reply" }).click();
    await expect(page.getByText("Saved answer 52", { exact: true })).toBeInViewport();
    await page.getByRole("button", { name: "First prompt", exact: true }).click();
    await expect(page.getByText("The original request before the terminal buffer")).toBeInViewport();
    await expect(page.getByRole("button", { name: "Copy loaded transcript" })).toBeEnabled();
    await page.screenshot({ path: testInfo.outputPath("conversation-dark.png"), animations: "disabled" });
    await page.evaluate(() => window.dispatchEvent(new Event("muxdeck:toggle-theme")));
    await page.screenshot({ path: testInfo.outputPath("conversation-light.png"), animations: "disabled" });

    await page.getByRole("checkbox", { name: "Show activity", exact: true }).check();
    const activity = page.locator(".agent-transcript-activity").filter({ hasText: "Checking files in a progress update" });
    await expect(activity).toBeVisible();
    await expect(activity.getByText("Checking files in a progress update")).not.toBeVisible();
    await activity.locator("summary").click();
    await expect(activity.getByText("Checking files in a progress update")).toBeVisible();
    await expect(activity.getByText("Detailed tool output")).toBeVisible();

    await page.getByRole("tab", { name: "Saved beginning", exact: true }).click();
    await expect(page.getByText("The original request before the terminal buffer")).toBeVisible();
    await expect(page.locator(".history-panel")).not.toContainText("Earlier messages are available");
    await page.getByRole("button", { name: "Recorded terminal output", exact: true }).click();
    await expect(page.locator(".saved-scrollback-content")).toContainText("Earlier messages are available");
    await page.getByRole("button", { name: "Read conversation from first prompt", exact: true }).click();
    await expect(page.getByText("The original request before the terminal buffer")).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.getByText("The original request before the terminal buffer")).toBeInViewport();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath("conversation-mobile.png"), animations: "disabled" });

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
