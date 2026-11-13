import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import type { SavedWorkspace } from "../src/api";
import { E2E_AUTH_PASSWORD, E2E_AUTH_USERNAME } from "./authFixture";

// A `/session/<name>?workspace=<id>` link (what agents print for a tab) must
// select the named tab, not the workspace's server-saved active session.
const tabRow = (page: Page, name: string) => page.locator(
  `.workspace-tab[data-workspace-session-name="${name}"]`,
);

test.use({ viewport: { width: 1440, height: 700 } });

async function login(context: BrowserContext): Promise<void> {
  const response = await context.request.post("/mux/api/auth/login", {
    data: { username: E2E_AUTH_USERNAME, password: E2E_AUTH_PASSWORD },
  });
  expect(response.ok()).toBe(true);
  await context.addInitScript(() => {
    localStorage.setItem("muxdeck-desktop-tab-orientation", "vertical");
  });
}

async function expectSelected(page: Page, name: string): Promise<void> {
  await expect(page.locator(".workspace-saved-indicator.saved")).toHaveCount(1);
  await expect(tabRow(page, name).getByRole("tab")).toHaveAttribute("aria-selected", "true");
  await expect.poll(() => decodeURIComponent(new URL(page.url()).pathname))
    .toBe(`/mux/session/${name}`);
}

test("session deep links select the named tab of a saved workspace", async ({ context, browser }) => {
  const socket = process.env.MUXDECK_PLAYWRIGHT_TMUX_SOCKET;
  if (!socket?.startsWith("muxdeck-playwright-")) throw new Error("Disposable test socket required");
  await login(context);
  const prefix = `deeplink-${process.pid}`;
  const [overseer, child, sibling, renamedFrom, renamedTo] = [
    `${prefix}-overseer`, `${prefix}-child`, `${prefix}-sibling`, `${prefix}-a2tv`, `${prefix}-ruler`,
  ];
  const tmux = (...args: string[]) => execFileSync("tmux", ["-L", socket, ...args]);
  const live = new Set<string>();
  const workspaceIds: string[] = [];
  let other: BrowserContext | null = null;
  try {
    // The reused name belonged to an earlier session that has since ended.
    for (const name of [overseer, child, sibling, renamedFrom]) {
      tmux("new-session", "-d", "-s", name, "bash", "--noprofile", "--norc");
      live.add(name);
    }
    tmux("kill-session", "-t", `=${renamedFrom}`);
    tmux("new-session", "-d", "-s", renamedFrom, "bash", "--noprofile", "--norc");

    const create = async (name: string, tabs: string[], parents: Record<string, string>) => {
      const response = await context.request.post("/mux/api/workspaces", {
        data: { name, tabs, activeSession: tabs[0], parents, groups: [] },
      });
      expect(response.ok()).toBe(true);
      const workspace = (await response.json()).workspace as SavedWorkspace;
      workspaceIds.push(workspace.id);
      return workspace;
    };
    // The same sessions are tabs of two workspaces; the second nests them.
    const source = await create(`${prefix} source`, [sibling, renamedFrom], {});
    const lab = await create(`${prefix} lab`, [overseer, sibling, renamedFrom, child], {
      [renamedFrom]: overseer, [child]: overseer,
    });
    const link = (workspace: SavedWorkspace, name: string) => (
      `/mux/session/${encodeURIComponent(name)}?workspace=${workspace.id}`
    );

    // The owner already has the lab open on its overseer in another browser.
    other = await browser.newContext({ viewport: { width: 1440, height: 700 } });
    await login(other);
    const existing = await other.newPage();
    await existing.goto(link(lab, overseer));
    await expectSelected(existing, overseer);

    // Fresh loads of each link select the named tab: a nested child, a tab
    // shared with another workspace, and a reused name.
    const page = await context.newPage();
    for (const [workspace, name] of [
      [lab, child], [lab, sibling], [source, renamedFrom], [lab, renamedFrom],
    ] as const) {
      await page.goto(link(workspace, name));
      await expectSelected(page, name);
    }

    // After a rename, the new name's link selects the renamed session too.
    expect((await context.request.put("/mux/api/session-name", {
      data: { session: renamedFrom, name: renamedTo },
    })).ok()).toBe(true);
    live.delete(renamedFrom);
    live.add(renamedTo);
    await page.goto(link(lab, renamedTo));
    await expectSelected(page, renamedTo);

    // Pasting a link into the page that already shows the workspace works too.
    await existing.goto(link(lab, child));
    await expectSelected(existing, child);
    // Following the link moves no other page's selection.
    await expect(tabRow(page, renamedTo).getByRole("tab")).toHaveAttribute("aria-selected", "true");
  } finally {
    await other?.close();
    for (const id of workspaceIds) await context.request.delete(`/mux/api/workspaces/${id}`);
    for (const name of live) {
      try { tmux("kill-session", "-t", `=${name}`); } catch { /* Already ended. */ }
    }
  }
});
