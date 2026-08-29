import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig } from "@playwright/test";

const runId = process.env.MUXDECK_PLAYWRIGHT_RUN_ID || `${process.pid}-${Date.now()}`;
const titlesFile = `/tmp/muxdeck-playwright-${runId}-titles.json`;
const messagesFile = `/tmp/muxdeck-playwright-${runId}-messages.json`;
const snippetsFile = `/tmp/muxdeck-playwright-${runId}-snippets.json`;
const workspacesFile = `/tmp/muxdeck-playwright-${runId}-workspaces.json`;
const uploadsDirectory = `/tmp/muxdeck-playwright-${runId}-uploads`;
const socketName = process.env.MUXDECK_PLAYWRIGHT_TMUX_SOCKET || `muxdeck-playwright-${runId}`;
const localPython = resolve(".venv/bin/python");
const pythonBin = process.env.MUXDECK_PLAYWRIGHT_PYTHON
  || (existsSync(localPython) ? localPython : "/usr/bin/python3");
const browserExecutable = process.env.MUXDECK_PLAYWRIGHT_BROWSER
  || (existsSync("/usr/bin/google-chrome") ? "/usr/bin/google-chrome" : undefined);

// Config is evaluated in multiple processes; inheriting the ID keeps cleanup exact.
process.env.MUXDECK_PLAYWRIGHT_RUN_ID = runId;
process.env.MUXDECK_PLAYWRIGHT_TITLES_FILE = titlesFile;
process.env.MUXDECK_PLAYWRIGHT_MESSAGES_FILE = messagesFile;
process.env.MUXDECK_PLAYWRIGHT_SNIPPETS_FILE = snippetsFile;
process.env.MUXDECK_PLAYWRIGHT_WORKSPACES_FILE = workspacesFile;
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
    command: `MUXDECK_PORT=7684 MUXDECK_TMUX_SOCKET=${socketName} MUXDECK_TITLES_FILE=${titlesFile} MUXDECK_MESSAGES_FILE=${messagesFile} MUXDECK_SNIPPETS_FILE=${snippetsFile} MUXDECK_WORKSPACES_FILE=${workspacesFile} MUXDECK_UPLOADS_DIR=${uploadsDirectory} ${pythonBin} -m tmux_console.app`,
    url: "http://127.0.0.1:7684/mux/api/health",
    reuseExistingServer: false,
    timeout: 10_000,
  },
});
