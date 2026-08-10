import { describe, expect, it } from "vitest";
import { prepareTerminalSubmission } from "../terminalInput";

describe("prepareTerminalSubmission", () => {
  it("normalizes multiline text and keeps Enter outside bracketed paste", () => {
    expect(prepareTerminalSubmission("first\nsecond\r\nthird", true, true)).toBe(
      "\x1b[200~first\rsecond\rthird\x1b[201~\r",
    );
  });

  it("preserves Unicode and does not add Enter unless requested", () => {
    expect(prepareTerminalSubmission("voice: こんにちは", false, false)).toBe("voice: こんにちは");
    expect(prepareTerminalSubmission("status", true, false)).toBe("status\r");
  });
});
