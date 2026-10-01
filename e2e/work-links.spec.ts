import { execFileSync } from "node:child_process";
import { expect, test, type APIRequestContext } from "@playwright/test";
import type { WorkLink, WorkLinkConfig, WorkLinkContext, NewWorkLink } from "../src/workLinks";
import { E2E_AUTH_PASSWORD, E2E_AUTH_USERNAME } from "./authFixture";

const socketName = process.env.MUXDECK_PLAYWRIGHT_TMUX_SOCKET;
if (!socketName?.startsWith("muxdeck-playwright-")) throw new Error("An isolated Playwright tmux socket is required");
const sessionName = `muxdeck-work-links-${process.pid}`;
const sessionPath = `/mux/api/sessions/${sessionName}/work-links`;

async function configure(request: APIRequestContext, changes: Record<string, unknown>) {
  const current = (await (await request.get("/mux/api/work-links/config")).json()).config as WorkLinkConfig;
  const response = await request.patch("/mux/api/work-links/config", { data: { expectedRevision: current.revision, ...changes } });
  expect(response.ok()).toBe(true);
}

async function addLink(request: APIRequestContext, link: NewWorkLink): Promise<WorkLink> {
  const current = await (await request.get(sessionPath)).json() as WorkLinkContext;
  const response = await request.post(sessionPath, { data: { ...link, historyId: current.session!.historyId } });
  expect(response.status()).toBe(201);
  return (await response.json()).link;
}

test.beforeAll(() => {
  execFileSync("tmux", ["-L", socketName, "new-session", "-d", "-s", sessionName, "bash", "--noprofile", "--norc"]);
});

test.beforeEach(async ({ context }) => {
  const login = await context.request.post("/mux/api/auth/login", { data: { username: E2E_AUTH_USERNAME, password: E2E_AUTH_PASSWORD } });
  expect(login.ok()).toBe(true);
  await configure(context.request, { enabled: true, providers: {
    github: { enabled: true, refreshEnabled: false }, jira: { enabled: true, refreshEnabled: false }, google_docs: { enabled: true, refreshEnabled: false },
  } });
  const current = await (await context.request.get(sessionPath)).json() as WorkLinkContext;
  for (const link of current.links) {
    expect((await context.request.delete(`/mux/api/work-links/${link.id}`, { data: { expectedRevision: link.revision } })).ok()).toBe(true);
  }
});

test.afterAll(() => {
  try { execFileSync("tmux", ["-L", socketName, "kill-session", "-t", `=${sessionName}`], { stdio: "ignore" }); }
  catch { /* Only this test session on its isolated socket is eligible for cleanup. */ }
});

test("agent API reports update chips while browser notes persist across reload and provider switches", async ({ page, context }, info) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/mux/session/${sessionName}`);
  await page.getByRole("button", { name: /^Work links/ }).click();
  const panel = page.getByRole("dialog", { name: `Work links for ${sessionName}` });
  await panel.getByRole("combobox", { name: "Type" }).selectOption("google_docs");
  const documentUrl = "https://docs.google.com/document/d/very-long-document-id-for-release-planning/edit?tab=t.long-tab-id";
  await panel.getByRole("textbox", { name: "Link URL" }).fill(documentUrl);
  await panel.getByRole("textbox", { name: "Document title" }).fill("Release planning");
  await panel.getByRole("button", { name: "Add link", exact: true }).click();
  await expect(page.getByRole("link", { name: "Doc Release planning", exact: true })).toHaveAttribute("href", documentUrl);
  const pr = await addLink(context.request, { provider: "github", url: "https://github.corp.example/team/repo/pull/317", title: "Add session work links" });
  await addLink(context.request, { provider: "jira", url: "https://jira.corp.example/browse/ENG-142" });
  const notes = panel.getByRole("textbox", { name: "Notes for Release planning" });
  await notes.fill("Keep the release decision and follow-up questions.");
  const blocked = await context.request.put(`/mux/api/work-links/${pr.id}/status`, { data: { expectedStatusRevision: 0, status: { state: "Approved" } } });
  expect(blocked.status()).toBe(409);
  await configure(context.request, { providers: { github: { refreshEnabled: true, instructions: "Use the work account on github.corp.example." } } });
  const report = await context.request.put(`/mux/api/work-links/${pr.id}/status`, { data: {
    expectedStatusRevision: 0, status: { state: "Changes requested", tone: "warning", summary: "CI passing. One review remains.", reportedBy: "test agent" },
  } });
  expect(report.ok()).toBe(true);
  await expect(panel.getByText("CI passing. One review remains.")).toBeVisible();
  await expect(notes).toHaveValue("Keep the release decision and follow-up questions.");
  await panel.getByRole("article", { name: "Release planning" }).getByRole("button", { name: "Save changes" }).click();
  await expect(panel.getByRole("article", { name: "Release planning" }).getByRole("button", { name: "Save changes" })).toBeDisabled();
  await page.reload();
  await expect(page.getByRole("dialog", { name: `Work links for ${sessionName}` })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Notes for Release planning" })).toHaveValue("Keep the release decision and follow-up questions.");
  await expect(page.getByRole("link", { name: /GitHub PR #317 Changes requested/ })).toBeVisible();
  await page.screenshot({ path: info.outputPath("work-links-desktop.png"), fullPage: true });
  await configure(context.request, { providers: { jira: { enabled: false } } });
  await expect(panel.getByRole("article", { name: "ENG-142" })).toHaveCount(0);
  await configure(context.request, { providers: { jira: { enabled: true } } });
  await expect(panel.getByRole("article", { name: "ENG-142" })).toBeVisible();
});

test("document title chips and status boxes fit a phone viewport", async ({ page, context }, info) => {
  const title = "Architecture decisions and implementation notes for the upcoming release";
  await addLink(context.request, { provider: "google_docs", title, url: "https://docs.google.com/document/d/long-document-id/edit?tab=t.long-tab" });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/mux/session/${sessionName}`);
  await expect(page.getByRole("link", { name: `Doc ${title}` })).toHaveAttribute("target", "_blank");
  await page.getByRole("button", { name: /^Work links/ }).click();
  const panel = page.getByRole("dialog", { name: `Work links for ${sessionName}` });
  await expect(panel.getByRole("textbox", { name: `Notes for ${title}` })).toBeVisible();
  const box = await panel.boundingBox();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(390);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.screenshot({ path: info.outputPath("work-links-mobile.png"), fullPage: true });
});
