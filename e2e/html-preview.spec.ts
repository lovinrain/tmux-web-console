import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { E2E_AUTH_PASSWORD, E2E_AUTH_USERNAME } from "./authFixture";

const socketName = process.env.MUXDECK_PLAYWRIGHT_TMUX_SOCKET;
if (!socketName?.startsWith("muxdeck-playwright-")) {
  throw new Error("HTML preview fixtures require the disposable Playwright tmux socket");
}
const tmux = ["-L", socketName];
const sessionName = `muxdeck-html-preview-${process.pid}`;
const reviewDirectory = "/tmp/muxdeck-interactive-html-review";
const cdnScript = "https://cdn.jsdelivr.net/npm/muxdeck-preview-fixture/report.js";
let fixtureDirectory = "";
let previewEndpoint = "";

test.use({ viewport: { width: 1440, height: 1000 } });

test.beforeAll(() => {
  fixtureDirectory = mkdtempSync("/tmp/muxdeck-html-preview-");
  const reportDirectory = join(fixtureDirectory, "report");
  const assetsDirectory = join(reportDirectory, "assets");
  mkdirSync(assetsDirectory, { recursive: true });
  mkdirSync(reviewDirectory, { recursive: true });
  writeFileSync(join(fixtureDirectory, "outside.json"), '{"outside":"must stay private"}');
  writeFileSync(join(reportDirectory, ".hidden.js"), "window.hiddenFile = true;");
  symlinkSync(join(fixtureDirectory, "outside.json"), join(reportDirectory, "escape.json"));
  writeFileSync(join(assetsDirectory, "data.json"), '{"message":"Local JSON loaded"}');
  writeFileSync(join(assetsDirectory, "app.js"), `
document.getElementById("external").textContent = "External script loaded";
document.getElementById("load-data").addEventListener("click", async () => {
  const result = await fetch("./assets/data.json").then(response => response.json());
  document.getElementById("data").textContent = result.message;
});
`);
  writeFileSync(join(assetsDirectory, "value.mjs"), 'export const message = "Imported module loaded";');
  writeFileSync(join(assetsDirectory, "module.mjs"), `
import { message } from "./value.mjs";
document.getElementById("module").textContent = message;
`);
  writeFileSync(join(assetsDirectory, "imported.css"), "#imported-style { color: rgb(64, 96, 128); }");
  writeFileSync(join(assetsDirectory, "style.css"), `
@import url("./imported.css");
@font-face { font-family: "PreviewFixture"; src: url("./font.woff2") format("woff2"); }
body { font-family: "PreviewFixture", sans-serif; margin: 48px; background: #f8fafc; color: #172033; }
main { max-width: 640px; padding: 32px; border: 1px solid #cbd5e1; border-radius: 12px; background: white; }
button { padding: 10px 16px; margin-right: 8px; }
#styled { background-color: rgb(228, 241, 235); padding: 12px; }
`);
  copyFileSync(
    "node_modules/@fontsource-variable/space-grotesk/files/space-grotesk-latin-wght-normal.woff2",
    join(assetsDirectory, "font.woff2"),
  );
  writeFileSync(join(assetsDirectory, "image.svg"), '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"><rect width="24" height="24" fill="#28845a"/></svg>');
  writeFileSync(join(reportDirectory, "report.html"), `<!doctype html>
<html><head><meta charset="utf-8"><title>Interactive HTML preview</title>
<link rel="stylesheet" href="./assets/style.css"></head><body><main>
<h1>Interactive HTML preview</h1>
<p id="styled">Relative styles loaded</p><p id="imported-style">Imported styles loaded</p>
<p id="inline">Waiting for inline script</p><p id="external">Waiting for external script</p>
<p id="module">Waiting for imported module</p><p id="cdn">Waiting for CDN script</p>
<img id="local-image" src="./assets/image.svg" alt="Local asset" width="24" height="24">
<p>Clicks: <output id="counter">0</output></p>
<button onclick="document.getElementById('counter').textContent = String(Number(document.getElementById('counter').textContent) + 1)">Increment</button>
<button id="load-data">Load local data</button><p id="data">No data loaded</p>
<script>document.getElementById("inline").textContent = "Inline script loaded";</script>
<script src="./assets/app.js"></script><script type="module" src="./assets/module.mjs"></script>
<script src="${cdnScript}"></script></main></body></html>`);
  execFileSync("tmux", [
    ...tmux, "new-session", "-d", "-s", sessionName, "-c", fixtureDirectory,
    "bash", "--noprofile", "--norc",
  ]);
  const [sessionId, paneId] = execFileSync("tmux", [
    ...tmux, "list-panes", "-t", `=${sessionName}`, "-F", "#{session_id}:#{pane_id}",
  ], { encoding: "utf8" }).trim().split(":");
  previewEndpoint = `/mux/api/sessions/${sessionName}/files/html?${new URLSearchParams({
    sessionId, paneId, path: "report/report.html",
  })}`;
});

test.beforeEach(async ({ context }) => {
  const login = await context.request.post("/mux/api/auth/login", {
    data: { username: E2E_AUTH_USERNAME, password: E2E_AUTH_PASSWORD },
  });
  expect(login.ok()).toBe(true);
  // Exercise the real CSP's CDN allowlist without relying on an external service.
  await context.route(cdnScript, async (route) => {
    await route.fulfill({
      contentType: "application/javascript",
      headers: { "Access-Control-Allow-Origin": "*" },
      body: 'document.getElementById("cdn").textContent = "CDN script loaded";',
    });
  });
});

test.afterEach(async ({ context }) => {
  await Promise.all(context.pages().map((page) => page.close()));
});

test.afterAll(() => {
  try {
    execFileSync("tmux", [...tmux, "kill-session", "-t", `=${sessionName}`], { stdio: "ignore" });
  } catch {
    // Only this fixture's exact session on its disposable socket is eligible.
  }
  if (fixtureDirectory) rmSync(fixtureDirectory, { recursive: true, force: true });
});

async function expectInteractivePreview(page: Page): Promise<void> {
  await expect(page).toHaveURL(/\/mux\/preview\/[A-Za-z0-9_-]+\/report\.html$/);
  await expect(page.getByRole("heading", { name: "Interactive HTML preview" })).toBeVisible();
  await expect(page.locator("#inline")).toHaveText("Inline script loaded");
  await expect(page.locator("#external")).toHaveText("External script loaded");
  await expect(page.locator("#module")).toHaveText("Imported module loaded");
  await expect(page.locator("#cdn")).toHaveText("CDN script loaded");
  await expect(page.locator("#styled")).toHaveCSS("background-color", "rgb(228, 241, 235)");
  await expect(page.locator("#imported-style")).toHaveCSS("color", "rgb(64, 96, 128)");
  await expect.poll(() => page.locator("#local-image").evaluate((node) => (node as HTMLImageElement).naturalWidth)).toBe(24);
  await expect.poll(() => page.evaluate(async () => {
    await document.fonts.ready;
    return [...document.fonts].some((font) => font.family === "PreviewFixture" && font.status === "loaded");
  })).toBe(true);
  await page.getByRole("button", { name: "Increment", exact: true }).click();
  await page.getByRole("button", { name: "Increment", exact: true }).click();
  await expect(page.locator("#counter")).toHaveText("2");
  await page.getByRole("button", { name: "Load local data", exact: true }).click();
  await expect(page.locator("#data")).toHaveText("Local JSON loaded");
  expect(await page.evaluate(() => window.opener === null)).toBe(true);
}

async function expectConsoleIsolation(page: Page, context: BrowserContext): Promise<void> {
  const beforeUrl = page.url();
  const probeUrl = `${new URL(beforeUrl).origin}/mux/api/health?html-preview-probe=blocked`;
  const escapedRequests: string[] = [];
  await context.route(probeUrl, async (route) => {
    escapedRequests.push(route.request().url());
    await route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
  });
  const protections = await page.evaluate(async (target) => {
    const denied = (read: () => unknown) => {
      try { read(); return false; } catch (error) { return (error as Error).name === "SecurityError"; }
    };
    let fetchDenied = false;
    try { await fetch(target, { credentials: "include" }); } catch { fetchDenied = true; }
    const frame = document.createElement("iframe");
    frame.src = target;
    document.body.append(frame);
    const form = document.createElement("form");
    form.action = target;
    form.method = "POST";
    document.body.append(form);
    form.submit();
    return {
      origin: window.origin,
      cookieDenied: denied(() => document.cookie),
      localStorageDenied: denied(() => localStorage.getItem("muxdeck")),
      fetchDenied,
      popupDenied: window.open(target, "_blank") === null,
    };
  }, probeUrl);
  expect(protections).toEqual({
    origin: "null", cookieDenied: true, localStorageDenied: true, fetchDenied: true, popupDenied: true,
  });
  // Give attempted navigations a rendering cycle to reach routing if unblocked.
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  expect(page.url()).toBe(beforeUrl);
  expect(escapedRequests).toEqual([]);
}

test("Open webpage runs inline, local, module, and CDN scripts in an isolated tab", async ({ page, context }) => {
  await page.goto(`/mux/session/${sessionName}?tab=${sessionName}`);
  await expect(page.locator(".connection-badge")).toContainText("Live", { timeout: 10_000 });
  await page.getByRole("button", { name: `Browse files in ${fixtureDirectory}`, exact: true }).click();
  const browser = page.getByRole("dialog", { name: "Files", exact: true });
  await browser.getByRole("button", { name: "Folder report", exact: true }).click();
  await browser.getByRole("button", { name: "File report.html", exact: true }).click();
  const open = browser.getByRole("link", { name: "Open report.html as webpage", exact: true });
  await expect(open).toHaveAttribute("target", "_blank");
  await expect(open).toHaveAttribute("rel", "noopener noreferrer");
  const opened = context.waitForEvent("page");
  await open.click();
  const preview = await opened;
  await expectInteractivePreview(preview);
  await preview.screenshot({ path: join(reviewDirectory, "file-browser-interactive-preview.png") });
  await expectConsoleIsolation(preview, context);
});

test("direct HTML links require authentication and issue a cookie-free, directory-scoped preview", async ({ page, context, playwright, baseURL }) => {
  const anonymous = await playwright.request.newContext({ baseURL });
  try {
    expect((await anonymous.get(previewEndpoint)).status()).toBe(401);
    // This is the endpoint also used when opening an absolute HTML terminal link.
    await page.goto(previewEndpoint);
    await expectInteractivePreview(page);
    await page.screenshot({ path: join(reviewDirectory, "direct-link-interactive-preview.png") });
    const grantBase = page.url().slice(0, page.url().lastIndexOf("/") + 1);
    const asset = await anonymous.get(`${grantBase}assets/data.json`);
    expect(asset.status()).toBe(200);
    expect(await asset.json()).toEqual({ message: "Local JSON loaded" });
    expect(asset.headers()["access-control-allow-origin"]).toBe("*");
    expect(asset.headers()["cross-origin-resource-policy"]).toBe("cross-origin");
    expect(asset.headers()["set-cookie"]).toBeUndefined();
    const html = await anonymous.get(page.url());
    expect(html.status()).toBe(200);
    expect(html.headers()["content-security-policy"]).toContain("sandbox allow-scripts");
    expect(html.headers()["content-security-policy"]).not.toContain("allow-same-origin");
    for (const path of [".hidden.js", "escape.json", "%2e%2e%2foutside.json", "%2Fetc%2Fpasswd", "assets/%2e%2e/%2e%2e/outside.json"]) {
      const rejected = await anonymous.get(`${grantBase}${path}`);
      // URL normalization may leave the preview route and reach normal auth.
      expect([400, 401, 403, 404], `request outside the granted report assets: ${path}`).toContain(rejected.status());
      expect(await rejected.text()).not.toContain("must stay private");
    }
    const invalidToken = `${new URL(page.url()).origin}/mux/preview/${"0".repeat(43)}/report.html`;
    expect((await anonymous.get(invalidToken)).status()).toBe(410);
    await expectConsoleIsolation(page, context);
  } finally {
    await anonymous.dispose();
  }
});
