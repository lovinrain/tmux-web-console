import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test, expect } from "@playwright/test";
import { E2E_AUTH_PASSWORD, E2E_AUTH_USERNAME } from "./authFixture";

// Opt-in real-agent verification uses a synthetic offline Claude conversation.
// The fixture owns its socket and lifecycle; never point this at a live session.
const statePath = process.env.MUXDECK_NATIVE_CLAUDE_FIXTURE;
const state: { socket: string; pane: string; session: string } | null = statePath
  ? JSON.parse(readFileSync(statePath, "utf8"))
  : null;
if (state && (!state.socket.startsWith("/tmp/muxdeck-claude-native-") || state.session !== "claude-native-fixture")) {
  throw new Error("Native scrolling browser checks require the isolated Claude fixture");
}

for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
  test(`native Claude scrolling and preferred controls at ${viewport.width}px`, async ({ page }) => {
    test.skip(!state, "Start the isolated synthetic Claude fixture to run this check");
    test.setTimeout(60_000);
    const tmux = ["-S", state!.socket];
    const capture = () => execFileSync("tmux", [...tmux, "capture-pane", "-p", "-t", state!.pane], { encoding: "utf8" });
    const mode = () => execFileSync("tmux", [...tmux, "display-message", "-p", "-t", state!.pane, "#{pane_in_mode}"], { encoding: "utf8" }).trim();
    const frames: { type?: string; profile?: string; direction?: string; message?: string }[] = [];
    page.on("websocket", (socket) => {
      socket.on("framereceived", ({ payload }) => {
        try { frames.push(JSON.parse(payload.toString())); } catch { /* terminal output */ }
      });
    });
    await page.setViewportSize(viewport);
    await page.goto("/mux/login");
    await page.getByLabel("Username").fill(E2E_AUTH_USERNAME);
    await page.getByLabel("Password").fill(E2E_AUTH_PASSWORD);
    await page.getByRole("button", { name: "Unlock Muxdeck" }).click();
    await expect(page).toHaveURL(/\/mux\/$/);
    await page.goto(`/mux/session/${state!.session}?tab=${state!.session}`);
    await expect(page.locator(".connection-badge")).toContainText("Live");
    await expect(page.locator(".console-shell")).toHaveAttribute("data-scroll-agent", "claude");
    const desktop = viewport.width > 1000;
    const controls = desktop
      ? page.getByRole("group", { name: "Terminal input shortcuts" })
      : page.getByRole("navigation", { name: "Terminal view controls" });
    const appUp = controls.getByRole("button", { name: "Application Scroll Up" });
    const appDown = controls.getByRole("button", { name: "Application Scroll Down" });
    const tmuxUp = controls.getByRole("button", { name: "Tmux Line Up" });
    const pageUp = controls.getByRole("button", { name: desktop ? "PgUp" : "Raw terminal Page Up", exact: true });
    await expect(appUp).toHaveAttribute("data-scroll-preferred", "true");
    await expect(tmuxUp).not.toHaveAttribute("data-scroll-preferred", "true");
    const beforePaging = capture();
    await pageUp.click();
    await expect.poll(capture).not.toBe(beforePaging);
    // Native controls must continue the application's paging position, without
    // entering tmux copy mode or modifying the synthetic draft.
    for (const button of [appUp, appDown, appUp, appDown]) {
      const before = capture();
      const acknowledgements = frames.filter((frame) => frame.type === "applicationScrollAck").length;
      await button.click();
      await expect.poll(() => frames.filter((frame) => frame.type === "applicationScrollAck").length).toBe(acknowledgements + 1);
      await expect.poll(capture).not.toBe(before);
      expect(capture()).toContain("DRAFT_SENTINEL_12345");
      expect(mode()).toBe("0");
    }
    await tmuxUp.click();
    await expect(tmuxUp).not.toHaveAttribute("data-scroll-preferred", "true");
    await expect(appUp).toHaveAttribute("data-scroll-preferred", "true");
    await expect.poll(mode).toBe("1");
    await appUp.click();
    await expect(appUp).toHaveAttribute("data-scroll-preferred", "true");
    await expect(pageUp).toHaveAttribute("data-scroll-preferred", "true");
    await expect.poll(mode).toBe("0");
    expect(capture()).toContain("DRAFT_SENTINEL_12345");
    await page.reload();
    await expect(appUp).toHaveAttribute("data-scroll-preferred", "true");
    await appUp.scrollIntoViewIfNeeded();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: `artifacts/native-claude-${viewport.width}.png`, animations: "disabled" });
    expect(frames.filter((frame) => frame.type === "applicationScrollNack")).toEqual([]);
  });
}
