import { beforeEach, expect, it, vi } from "vitest";
import { writeTranscriptPrint } from "./TranscriptPrint";
import type { TranscriptExport } from "../transcriptExport";

beforeEach(() => vi.resetAllMocks());

it("builds a printable full conversation with safe Markdown and selectable code without active HTML or remote images", () => {
  const print = vi.fn();
  const doc = document.implementation.createHTMLDocument();
  const popup = { document: doc, closed: false, print } as unknown as Window;
  const transcript: TranscriptExport = {
    source: { key: "codex:id", agentType: "codex", agentSessionId: "id" }, view: "conversation", exportedAt: 0,
    notices: ["Some native records were unreadable."],
    messages: [{
      id: "reply", role: "assistant", timestamp: 0, truncated: true,
      text: "## A reply\n\n**Ready**\n\n```js\nconst safe = '<html>';\n```\n\n[Docs](https://example.test/docs)\n[Unsafe](javascript:alert%281%29)\n![Private](https://example.test/image.png)\n<script>window.secret = true</script>",
    }],
  };
  writeTranscriptPrint(popup, transcript, '<img src=x onerror=alert(1)> "Title"');
  expect(doc.querySelector("main > header > h1")?.textContent).toBe('<img src=x onerror=alert(1)> "Title"');
  expect(doc.querySelector(".agent-transcript-markdown h2")?.textContent).toBe("A reply");
  expect(doc.querySelector("pre")?.textContent).toContain("const safe = '<html>';");
  expect(doc.querySelector("script, img")).toBeNull();
  expect(doc.querySelector('a[href^="javascript:"]')).toBeNull();
  expect(doc.body.textContent).toContain("Some native records were unreadable.");
  expect(doc.body.textContent).toContain("This long entry was shortened.");
  expect(doc.querySelector("style")?.textContent).toContain("@media print");
  expect(doc.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute("content")).toContain("script-src 'none'");
  doc.getElementById("print-transcript")?.click();
  expect(print).toHaveBeenCalledOnce();
});
