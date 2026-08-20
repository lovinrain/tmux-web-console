import { describe, expect, it } from "vitest";
import { prepareTerminalSubmission } from "../terminalInput";

describe("prepareTerminalSubmission", () => {
  it("normalizes multiline text and keeps Enter outside bracketed paste", () => {
    expect(prepareTerminalSubmission("first\nsecond\r\nthird", "enter", true)).toBe(
      "\x1b[200~first\rsecond\rthird\x1b[201~\r",
    );
  });

  it("preserves Unicode and does not add Enter unless requested", () => {
    expect(prepareTerminalSubmission("voice: こんにちは", "none", false)).toBe("voice: こんにちは");
    expect(prepareTerminalSubmission("status", "enter", false)).toBe("status\r");
  });

  it("keeps the terminal Tab after the bracketed-paste close sequence", () => {
    expect(prepareTerminalSubmission("choose\tnext", "tab", true)).toBe(
      "\x1b[200~choose\tnext\x1b[201~\t",
    );
  });
});
