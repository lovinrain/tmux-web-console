import { describe, expect, it } from "vitest";
import { agentDisplayLabel, agentResumeCommand } from "./agentResume";

describe("agentResumeCommand", () => {
  it("builds the verified resume invocation for each agent", () => {
    const id = "df0316ae-6484-4533-8bed-54a677121a2e";
    expect(agentResumeCommand("claude", id)).toBe(`claude -r ${id}`);
    expect(agentResumeCommand("codex", id)).toBe(`codex resume ${id}`);
    expect(agentResumeCommand("cursor", id)).toBe(`cursor-agent --resume ${id}`);
    expect(agentResumeCommand("grok", id)).toBe(`grok -r ${id}`);
    expect(agentResumeCommand("pi", id)).toBe(`pi --session ${id}`);
    expect(agentResumeCommand("omp", id)).toBe(`omp --resume ${id}`);
    expect(agentResumeCommand("agy", id)).toBe(`agy --conversation ${id}`);
    const openCodeId = "ses_1234567890abcdefghijklmnop";
    expect(agentResumeCommand("opencode", openCodeId, "/work/project"))
      .toBe(`cd -- '/work/project' && opencode --session ${openCodeId}`);
  });

  it.each(["pi", "omp", "opencode", "agy"] as const)("only offers %s resume for an exact native ID", (agent) => {
    expect(agentResumeCommand(agent, "--help")).toBeNull();
    expect(agentResumeCommand(agent, "../session.jsonl")).toBeNull();
  });

  it.each([
    ["claude", "claude -r"],
    ["codex", "codex resume"],
    ["cursor", "cursor-agent --resume"],
    ["grok", "grok -r"],
  ] as const)("changes directory before resuming %s", (agent, invocation) => {
    expect(agentResumeCommand(agent, "recorded-id", "/work/project"))
      .toBe(`cd -- '/work/project' && ${invocation} recorded-id`);
  });

  it.each([
    ["/work/a project", "'/work/a project'"],
    ["/work/O'Brien", "'/work/O'\\''Brien'"],
    ["/work/$HOME; $(echo literal)", "'/work/$HOME; $(echo literal)'"],
    ["-project", "'-project'"],
  ])("quotes the saved directory %s as a literal shell argument", (directory, quoted) => {
    expect(agentResumeCommand("codex", "recorded-id", directory))
      .toBe(`cd -- ${quoted} && codex resume recorded-id`);
  });

  it("quotes shell metacharacters in recorded IDs", () => {
    expect(agentResumeCommand("claude", "id'; echo literal", "/work/project"))
      .toBe("cd -- '/work/project' && claude -r 'id'\\''; echo literal'");
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
    expect(agentDisplayLabel("pi")).toBe("Pi");
    expect(agentDisplayLabel("omp")).toBe("OMP");
    expect(agentDisplayLabel("opencode")).toBe("OpenCode");
    expect(agentDisplayLabel("agy")).toBe("Antigravity");
    expect(agentDisplayLabel(null)).toBe("Shell");
  });
});
