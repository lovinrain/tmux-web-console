import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  AGENT_SCROLL_PREFERENCES_STORAGE_KEY,
  loadAgentScrollPreferences,
  preferredAgentScrollMode,
  rememberAgentScrollMode,
} from "./agentScrollPreferences";

beforeEach(() => {
  window.localStorage.clear();
  vi.restoreAllMocks();
});

describe("agent scroll preferences", () => {
  it("uses agent-aware defaults", () => {
    expect(preferredAgentScrollMode("claude", {})).toBe("application");
    expect(preferredAgentScrollMode("codex", {})).toBe("tmux");
    expect(preferredAgentScrollMode("copilot", {})).toBe("application");
    expect(preferredAgentScrollMode("cursor", {})).toBe("application");
    expect(preferredAgentScrollMode("grok", {})).toBe("application");
    expect(preferredAgentScrollMode("shells", {})).toBe("tmux");
    expect(preferredAgentScrollMode("other", {})).toBe("tmux");
  });

  it("stores successful overrides per agent kind", () => {
    const preferences = rememberAgentScrollMode({}, "claude", "tmux");
    const next = rememberAgentScrollMode(preferences, "codex", "application");

    expect(loadAgentScrollPreferences()).toEqual({
      claude: "tmux",
      codex: "application",
    });
    expect(preferredAgentScrollMode("claude", next)).toBe("tmux");
    expect(preferredAgentScrollMode("codex", next)).toBe("application");
  });

  it("ignores malformed storage and unknown values", () => {
    window.localStorage.setItem(AGENT_SCROLL_PREFERENCES_STORAGE_KEY, "not-json");
    expect(loadAgentScrollPreferences()).toEqual({});

    window.localStorage.setItem(AGENT_SCROLL_PREFERENCES_STORAGE_KEY, JSON.stringify({
      claude: "sideways",
      codex: "application",
      future: "tmux",
    }));
    expect(loadAgentScrollPreferences()).toEqual({ codex: "application" });
  });

  it("keeps an in-memory override when browser storage is unavailable", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("storage disabled");
    });

    expect(rememberAgentScrollMode({}, "claude", "tmux")).toEqual({ claude: "tmux" });
  });
});
