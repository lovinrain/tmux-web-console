import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, expect } from "@playwright/test";
import { E2E_AUTH_PASSWORD, E2E_AUTH_USERNAME } from "./authFixture";

// Opt in with the installed native Codex binary. All content and configuration
// are synthetic; the provider is an unused loopback port and no prompt is sent.
const binary = process.env.MUXDECK_NATIVE_CODEX_BINARY;
const socket = process.env.MUXDECK_PLAYWRIGHT_TMUX_SOCKET || "";
const session = `muxdeck-codex-scroll-${process.pid}`;
let directory = "";
let pane = "";
const tmux = (...args: string[]) => execFileSync("tmux", ["-L", socket, ...args], {
  encoding: "utf8", timeout: 8000,
}).trim();
const capture = () => tmux("capture-pane", "-p", "-t", pane);
const firstRow = () => Number(capture().match(/CODEX_ROW_(\d+)/)?.[1] ?? -1);
const draft = "DRAFT_SENTINEL_12345";

test.skip(!binary, "Set MUXDECK_NATIVE_CODEX_BINARY to verify the installed Codex CLI");

test.beforeAll(async () => {
  if (!/^muxdeck-playwright-[a-zA-Z0-9_-]+$/.test(socket)) {
    throw new Error("Native Codex checks require an isolated Playwright tmux socket");
  }
  directory = mkdtempSync(join(tmpdir(), "muxdeck-codex-scroll-browser-"));
  const workspace = join(directory, "workspace");
  const fixtureHome = join(directory, "codex-home");
  mkdirSync(workspace);
  mkdirSync(fixtureHome);
  writeFileSync(join(fixtureHome, "config.toml"), `model = "gpt-6-sol"
model_provider = "fixture"
suppress_unstable_features_warning = true
analytics.enabled = false
[features]
daemon_auto_start = false
api_key_model_discovery = false
codex_apps = false
[model_providers.fixture]
name = "Offline scrolling fixture"
base_url = "http://127.0.0.1:9/v1"
wire_api = "responses"
requires_openai_auth = false
[projects."${workspace}"]
trust_level = "trusted"
`, { mode: 0o600 });
  const identifier = randomUUID();
  const timestamp = new Date().toISOString();
  const sessions = join(fixtureHome, "sessions", ...timestamp.slice(0, 10).split("-"));
  mkdirSync(sessions, { recursive: true });
  const answer = "```text\n" + Array.from({ length: 240 }, (_, index) => `CODEX_ROW_${String(index).padStart(3, "0")}`).join("\n") + "\n```";
  const prompt = "Show the synthetic scrolling rows";
  const records = [
    { type: "session_meta", payload: { id: identifier, session_id: identifier, timestamp,
      cwd: workspace, originator: "codex_cli_rs", cli_version: "0.157.1", source: "cli", model_provider: "fixture" } },
    { type: "event_msg", payload: { type: "user_message", message: prompt, images: [], local_images: [] } },
    { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: prompt }] } },
    { type: "response_item", payload: { type: "message", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: answer }] } },
    { type: "event_msg", payload: { type: "agent_message", message: answer, phase: "final_answer" } },
  ];
  writeFileSync(join(sessions, `rollout-${timestamp.slice(0, 19).replaceAll(":", "-")}-${identifier}.jsonl`),
    records.map((record) => JSON.stringify({ timestamp, ...record })).join("\n") + "\n", { mode: 0o600 });
  // Configure this disposable session before starting Codex so mouse=off is
  // deterministic. No option or input touches the user's default server.
  pane = tmux("new-session", "-d", "-P", "-F", "#{pane_id}", "-s", session, "-x", "180", "-y", "38", "sleep", "180");
  const sessionId = tmux("display-message", "-p", "-t", pane, "#{session_id}");
  tmux("set-option", "-t", sessionId, "mouse", "off");
  const tmuxEnvironment = tmux("display-message", "-p", "-t", pane, "#{socket_path},#{pid},#{session_id}")
    .replace(/,\$(\d+)$/, ",$1");
  tmux("respawn-pane", "-k", "-t", pane, "-c", workspace, "env", "-i",
    `PATH=${process.env.PATH}`, `HOME=${process.env.HOME}`, "LANG=C.UTF-8",
    `TMUX=${tmuxEnvironment}`, `TMUX_PANE=${pane}`,
    "TERM=tmux-256color", "COLORTERM=truecolor", `CODEX_HOME=${fixtureHome}`,
    binary!, "--no-daemon", "-C", workspace, "resume", identifier);
  await expect.poll(capture, { timeout: 15_000 }).toContain("CODEX_ROW_239");
  tmux("send-keys", "-t", pane, "-l", draft);
  await expect.poll(capture).toContain(draft);
});

test.afterAll(() => {
  if (pane) tmux("kill-session", "-t", `=${session}`);
  if (directory) rmSync(directory, { recursive: true, force: true });
});

for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
  test(`real Codex fine scrolling continues native pages at ${viewport.width}px`, async ({ context, page }, testInfo) => {
    const rejected: unknown[] = [];
    page.on("websocket", (socket) => socket.on("framereceived", ({ payload }) => {
      try {
        const frame = JSON.parse(payload.toString());
        if (frame.type === "applicationScrollNack") rejected.push(frame);
      } catch { /* raw terminal output */ }
    }));
    expect((await context.request.post("/mux/api/auth/login", {
      data: { username: E2E_AUTH_USERNAME, password: E2E_AUTH_PASSWORD },
    })).ok()).toBe(true);
    await page.setViewportSize(viewport);
    await page.goto(`/mux/session/${session}?tab=${session}`);
    await expect(page.locator(".connection-badge")).toContainText("Live");
    await expect(page.locator(".console-shell")).toHaveAttribute("data-scroll-agent", "codex");
    await expect.poll(capture).toContain(draft);
    const mobile = viewport.width <= 640;
    const controls = mobile
      ? page.getByRole("navigation", { name: "Terminal view controls" })
      : page.getByRole("group", { name: "Terminal input shortcuts" });
    const pageUp = controls.getByRole("button", { name: mobile ? "Raw terminal Page Up" : "PgUp", exact: true });
    const pageDown = controls.getByRole("button", { name: mobile ? "Raw terminal Page Down" : "PgDn", exact: true });
    const up = controls.getByRole("button", { name: "Application Scroll Up" });
    const down = controls.getByRole("button", { name: "Application Scroll Down" });
    await expect(up).toHaveAttribute("data-scroll-preferred", "true");
    await expect(up).toHaveAttribute("title", /three rows/);
    expect(tmux("display-message", "-p", "-t", pane, "#{mouse_any_flag}:#{mouse_sgr_flag}:#{alternate_on}")).toBe("0:0:1");
    const beforePage = firstRow();
    await pageUp.click();
    await expect.poll(firstRow).toBeLessThan(beforePage);
    for (const [button, delta] of [[up, -3], [up, -3], [down, 3], [down, 3]] as const) {
      const before = firstRow();
      await button.click();
      await expect.poll(firstRow).toBe(before + delta);
      await expect(button).toBeEnabled();
      expect(capture()).toContain(draft);
      expect(tmux("display-message", "-p", "-t", pane, "#{pane_in_mode}")).toBe("0");
    }
    const nativePosition = firstRow();
    await controls.getByRole("button", { name: "Tmux Line Up" }).click();
    await expect.poll(() => tmux("display-message", "-p", "-t", pane, "#{pane_in_mode}")).toBe("1");
    await up.click();
    await expect.poll(firstRow).toBe(nativePosition - 3);
    await expect.poll(() => tmux("display-message", "-p", "-t", pane, "#{pane_in_mode}")).toBe("0");
    await pageDown.click();
    await expect.poll(firstRow).toBeGreaterThan(nativePosition);
    expect(capture()).toContain(draft);
    expect(rejected).toEqual([]);
    await page.screenshot({ path: testInfo.outputPath("codex-native-scroll.png"), animations: "disabled" });
  });
}
