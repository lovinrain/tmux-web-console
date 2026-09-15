import { describe, expect, it } from "vitest";
import { agentDisplayLabel, agentResumeCommand } from "./agentResume";

describe("agentResumeCommand", () => {
  it("builds the verified resume invocation for each agent", () => {
    const id = "df0316ae-6484-4533-8bed-54a677121a2e";
    expect(agentResumeCommand("claude", id)).toBe(`claude -r ${id}`);
    expect(agentResumeCommand("codex", id)).toBe(`codex resume ${id}`);
    expect(agentResumeCommand("cursor", id)).toBe(`cursor-agent --resume ${id}`);
    expect(agentResumeCommand("grok", id)).toBe(`grok -r ${id}`);
  });

  it("offers no command without a recorded id", () => {
    expect(agentResumeCommand("claude", null)).toBeNull();
    expect(agentResumeCommand(null, null)).toBeNull();
    expect(agentResumeCommand(null, "some-id")).toBeNull();
  });

  it("offers no command for agents with no verified resume form", () => {
    // Copilot is deliberately excluded: no resume-by-id form was confirmed.
    expect(agentResumeCommand("copilot", "abc")).toBeNull();
  });
});

describe("agentDisplayLabel", () => {
  it("names each agent and falls back to Shell", () => {
    expect(agentDisplayLabel("claude")).toBe("Claude");
    expect(agentDisplayLabel("cursor")).toBe("Cursor");
    expect(agentDisplayLabel(null)).toBe("Shell");
  });
});
