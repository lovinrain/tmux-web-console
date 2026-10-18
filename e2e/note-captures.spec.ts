import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { test, expect } from "@playwright/test";
import { E2E_AUTH_PASSWORD, E2E_AUTH_USERNAME } from "./authFixture";

const socket = process.env.MUXDECK_PLAYWRIGHT_TMUX_SOCKET;
if (!socket?.startsWith("muxdeck-playwright-")) throw new Error("Note capture tests require a disposable tmux socket");
const tmux = ["-L", socket];
const source = `muxdeck-note-capture-${process.pid}`;
const viewer = `${source}-viewer`;
const url = (name: string) => `/mux/session/${name}?tab=${name}`;
let sourcePane = "";

test.beforeAll(() => {
  for (const name of [source, viewer]) {
    execFileSync("tmux", [...tmux, "new-session", "-d", "-s", name, "-x", "120", "-y", "30",
      "sh", "-c", "printf 'CAPTURE WORKFLOW\\noriginal terminal text for sticky notes\\n'; exec cat"]);
  }
  sourcePane = execFileSync("tmux", [...tmux, "list-panes", "-t", `=${source}`, "-F", "#{pane_id}"], { encoding: "utf8" }).trim();
});
test.afterAll(() => {
  for (const name of [source, viewer]) {
    try { execFileSync("tmux", [...tmux, "kill-session", "-t", `=${name}`], { stdio: "ignore" }); }
    catch { /* The source is deliberately ended in the workflow below. */ }
  }
});

test("crop to notes, OCR, pasted images, reload and ended-source storage management", async ({ page }, info) => {
  test.setTimeout(90_000);
  page.setDefaultTimeout(10_000);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/mux/login");
  await page.getByLabel("Username").fill(E2E_AUTH_USERNAME);
  await page.getByLabel("Password").fill(E2E_AUTH_PASSWORD);
  await page.getByRole("button", { name: "Unlock Muxdeck" }).click();
  await expect(page).toHaveURL(/\/mux\/$/);
  const request = page.request;
  expect((await request.put("/mux/api/common-note", { data: { note: "Existing notebook text stays" } })).ok()).toBe(true);
  await page.goto(url(source));
  await expect(page.locator(".connection-badge")).toContainText("Live");
  await expect(page.locator(".xterm-rows")).toContainText("CAPTURE WORKFLOW");
  await page.getByRole("button", { name: "Capture to notes", exact: true }).click();
  const capture = page.getByRole("dialog", { name: "Capture to notes", exact: true });
  await expect(capture.getByRole("button", { name: "Capture visible pane" })).toBeEnabled();
  await capture.getByRole("combobox", { name: "Capture format" }).selectOption("both");
  await capture.getByRole("combobox", { name: "Capture note scope" }).selectOption("common");
  await expect(capture.getByRole("combobox", { name: "Capture note page" })).toBeEnabled();
  const frame = await capture.locator(".note-capture-frame").boundingBox();
  expect(frame).not.toBeNull();
  await page.mouse.move(frame!.x + 2, frame!.y + 2);
  await page.mouse.down();
  await page.mouse.move(frame!.x + frame!.width * .92, frame!.y + frame!.height * .6, { steps: 5 });
  await page.mouse.up();
  const toast = page.locator(".note-capture-toast");
  await expect(toast).toContainText("Saved to Global note");
  await toast.getByRole("button", { name: "Open note" }).click();
  let note = page.getByRole("dialog", { name: "Common", exact: true });
  await expect(note.getByRole("textbox", { name: "Note", exact: true })).toHaveValue("Existing notebook text stays");
  await expect(note.locator(".note-clip pre")).toContainText("CAPTURE WORKFLOW");
  const image = note.getByRole("img", { name: `Capture from ${source}` });
  await expect(image).toBeVisible();
  const images = await (await request.get("/mux/api/note-captures?scope=common&target=common&pageId=main")).json();
  const id = images.captures[0].id as string;
  const png = await request.get(`/mux/api/note-captures/${id}/image`);
  expect(png.ok()).toBe(true);
  const pngBytes = await png.body();
  writeFileSync(info.outputPath("captured-terminal.png"), pngBytes);
  const colors = await page.evaluate(async (path) => {
    const bitmap = await createImageBitmap(await (await fetch(path)).blob());
    const canvas = document.createElement("canvas"); canvas.width = bitmap.width; canvas.height = bitmap.height;
    const context = canvas.getContext("2d")!; context.drawImage(bitmap, 0, 0);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    const colors = new Set<string>();
    for (let offset = 0; offset < pixels.length; offset += 4) colors.add(`${pixels[offset]},${pixels[offset + 1]},${pixels[offset + 2]}`);
    bitmap.close(); return colors.size;
  }, `/mux/api/note-captures/${id}/image`);
  expect(colors).toBeGreaterThan(20);
  const storage = await (await request.get("/mux/api/note-captures/storage")).json();
  if (storage.ocrAvailable) {
    await note.getByRole("button", { name: "Extract text" }).click();
    const text = note.getByRole("textbox", { name: "Capture text", exact: true });
    await expect(text).toHaveValue(/WORKFLOW/i);
    await text.fill("Reviewed OCR text");
    await note.getByRole("button", { name: "Save text" }).click();
    await expect(note.locator(".note-clip pre")).toContainText("Reviewed OCR text");
  }
  // OS screenshot paste follows the same note-canvas path, with an actual image File.
  await note.getByRole("textbox", { name: "Note", exact: true }).evaluate((element, bytes) => {
    const clipboardData = new DataTransfer();
    clipboardData.items.add(new File([new Uint8Array(bytes)], "pasted.png", { type: "image/png" }));
    element.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, clipboardData }));
  }, Array.from(pngBytes));
  await expect(note.locator(".note-clip")).toHaveCount(2);
  for (const theme of ["light", "dark"]) {
    if (await page.locator("html").getAttribute("data-theme") !== theme) await page.evaluate(() => window.dispatchEvent(new Event("muxdeck:toggle-theme")));
    await note.getByRole("button", { name: "Resize note to Small" }).click();
    expect(await note.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath(`note-captures-${theme}.png`) });
  }
  await page.reload();
  note = page.getByRole("dialog", { name: "Common", exact: true });
  await expect(note.locator(".note-clip")).toHaveCount(2);
  expect((await (await request.get("/mux/api/common-note")).json()).note).toBe("Existing notebook text stays");
  await note.getByRole("button", { name: "Save and close note" }).click();
  const firstRow = await page.locator(".xterm-rows > div").first().boundingBox();
  expect(firstRow).not.toBeNull();
  await page.mouse.move(firstRow!.x + 2, firstRow!.y + firstRow!.height / 2);
  await page.mouse.down();
  await page.mouse.move(firstRow!.x + 180, firstRow!.y + firstRow!.height / 2, { steps: 5 });
  await page.mouse.up();
  await page.getByRole("button", { name: "Add selected text to note" }).click();
  await expect(page.getByRole("textbox", { name: "Text to capture" })).toHaveValue(/CAPTURE/);
  await page.getByRole("button", { name: "Cancel note capture" }).click();
  await page.getByRole("button", { name: "Enter desktop terminal focus" }).click();
  await page.getByRole("button", { name: "Capture to notes", exact: true }).click();
  await expect(capture.getByRole("button", { name: "Capture visible pane" })).toBeEnabled();
  await page.keyboard.press("Escape");
  await expect(capture).toBeHidden();
  await page.getByRole("button", { name: "Exit desktop terminal focus" }).click();
  const output = execFileSync("tmux", [...tmux, "capture-pane", "-p", "-t", sourcePane], { encoding: "utf8" });
  expect(output).not.toContain("Reviewed OCR text");
  execFileSync("tmux", [...tmux, "kill-session", "-t", `=${source}`]);
  await page.goto(url(viewer));
  const card = page.getByRole("button", { name: "Edit common note" });
  await expect(card).toContainText("images from ended sessions");
  await page.getByRole("button", { name: "Manage note image storage" }).click();
  const manager = page.getByRole("dialog", { name: "Note image storage" });
  await expect(manager).toContainText("2 images from ended sessions");
  await manager.getByRole("button", { name: "Keep", exact: true }).first().click();
  await expect(manager.getByRole("button", { name: "Stop keeping" })).toHaveCount(1);
  await manager.getByRole("button", { name: "Review cleanup of 1 ended images" }).click();
  await manager.getByRole("button", { name: "Delete ended images", exact: true }).click();
  await expect(manager.locator(".note-storage-list article")).toHaveCount(1);
  const retained = await (await request.get("/mux/api/note-captures?scope=common&target=common&pageId=main")).json();
  expect(retained.captures).toHaveLength(2);
  expect(retained.captures.filter((item: { imageBytes: number }) => item.imageBytes > 0)).toHaveLength(1);
  expect(retained.captures.some((item: { text: string }) => item.text.length > 0)).toBe(true);
});
