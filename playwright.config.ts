import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig } from "@playwright/test";
import { E2E_AUTH_PASSWORD, E2E_AUTH_USERNAME } from "./e2e/authFixture";

const runId = process.env.MUXDECK_PLAYWRIGHT_RUN_ID || `${process.pid}-${Date.now()}`;
const titlesFile = `/tmp/muxdeck-playwright-${runId}-titles.json`;
const messagesFile = `/tmp/muxdeck-playwright-${runId}-messages.json`;
const snippetsFile = `/tmp/muxdeck-playwright-${runId}-snippets.json`;
const workspacesFile = `/tmp/muxdeck-playwright-${runId}-workspaces.json`;
const shortcutsFile = `/tmp/muxdeck-playwright-${runId}-shortcuts.json`;
const authFile = `/tmp/muxdeck-playwright-${runId}-auth.json`;
const uploadsDirectory = `/tmp/muxdeck-playwright-${runId}-uploads`;
const socketName = process.env.MUXDECK_PLAYWRIGHT_TMUX_SOCKET || `muxdeck-playwright-${runId}`;
const localPython = resolve(".venv/bin/python");
const pythonBin = process.env.MUXDECK_PLAYWRIGHT_PYTHON
  || (existsSync(localPython) ? localPython : "/usr/bin/python3");
const browserExecutable = process.env.MUXDECK_PLAYWRIGHT_BROWSER
  || (existsSync("/usr/bin/google-chrome") ? "/usr/bin/google-chrome" : undefined);

if (!existsSync(authFile)) {
  const provisioned = spawnSync(
    pythonBin,
    [
      "-c",
      "import sys; from pathlib import Path; from tmux_console.auth import provision_auth_file; username, password = sys.stdin.read().splitlines(); provision_auth_file(Path(sys.argv[1]), username, password)",
      authFile,
    ],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      input: `${E2E_AUTH_USERNAME}\n${E2E_AUTH_PASSWORD}\n`,
    },
  );
  if (provisioned.status !== 0) {
    throw new Error(`Unable to provision Playwright authentication: ${provisioned.stderr}`);
  }
}

// Config is evaluated in multiple processes; inheriting the ID keeps cleanup exact.
process.env.MUXDECK_PLAYWRIGHT_RUN_ID = runId;
process.env.MUXDECK_PLAYWRIGHT_TITLES_FILE = titlesFile;
process.env.MUXDECK_PLAYWRIGHT_MESSAGES_FILE = messagesFile;
process.env.MUXDECK_PLAYWRIGHT_SNIPPETS_FILE = snippetsFile;
process.env.MUXDECK_PLAYWRIGHT_WORKSPACES_FILE = workspacesFile;
process.env.MUXDECK_PLAYWRIGHT_SHORTCUTS_FILE = shortcutsFile;
process.env.MUXDECK_PLAYWRIGHT_AUTH_FILE = authFile;
process.env.MUXDECK_PLAYWRIGHT_UPLOADS_DIR = uploadsDirectory;
process.env.MUXDECK_PLAYWRIGHT_TMUX_SOCKET = socketName;

export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  fullyParallel: false,
  workers: 1,
  reporter: "line",
  use: {
    baseURL: "http://127.0.0.1:7684",
    browserName: "chromium",
    launchOptions: browserExecutable ? { executablePath: browserExecutable } : undefined,
    trace: "retain-on-failure",
  },
  webServer: {
    command: `MUXDECK_PORT=7684 MUXDECK_TMUX_SOCKET=${socketName} MUXDECK_TITLES_FILE=${titlesFile} MUXDECK_MESSAGES_FILE=${messagesFile} MUXDECK_SNIPPETS_FILE=${snippetsFile} MUXDECK_WORKSPACES_FILE=${workspacesFile} MUXDECK_SHORTCUTS_FILE=${shortcutsFile} MUXDECK_AUTH_MODE=server MUXDECK_AUTH_FILE=${authFile} MUXDECK_AUTH_COOKIE_SECURE=false MUXDECK_UPLOADS_DIR=${uploadsDirectory} ${pythonBin} -m tmux_console.app`,
    url: "http://127.0.0.1:7684/mux/login",
    reuseExistingServer: false,
    timeout: 10_000,
  },
});
