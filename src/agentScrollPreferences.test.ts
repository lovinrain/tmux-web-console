import { describe, expect, it } from "vitest";
import {
  applicationScrollProfile,
  preferredAgentScrollMode,
} from "./agentScrollPreferences";

describe("agent scroll recommendations", () => {
  it.each([
    ["claude", "application"],
    ["codex", "application"],
    ["copilot", "application"],
    ["cursor", "tmux"],
    ["grok", "application"],
    ["shells", "tmux"],
    ["other", "tmux"],
  ] as const)("recommends %s scrolling using %s", (kind, expected) => {
    expect(preferredAgentScrollMode(kind)).toBe(expected);
  });

  it("only enables application wheel scrolling for verified agent profiles", () => {
    expect(applicationScrollProfile("claude")).toBe("claude");
    expect(applicationScrollProfile("codex")).toBe("codex");
    expect(applicationScrollProfile("copilot")).toBe("copilot");
    expect(applicationScrollProfile("grok")).toBe("grok");
    for (const kind of ["cursor", "shells", "other"] as const) {
      expect(applicationScrollProfile(kind)).toBeNull();
    }
  });
});
