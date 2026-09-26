import { describe, expect, it } from "vitest";
import type { CallbackMessage } from "./api";
import {
  DEFAULT_CALLBACK_LIST_VIEW,
  callbackEntryLatestCallbackAt,
  callbackEntryReadySince,
  callbackStatus,
  filterAndSortCallbacks,
  parseCallbackListViewPreferences,
  validateCallbackListViewPreferences,
  type CallbackListEntry,
  type CallbackListViewPreferences,
} from "./callbackListView";
import type { Pane, Session } from "./types";

function session(name: string, overrides: Partial<Session> = {}): Session {
  return {
    name, id: `id-${name}`, windows: 1, attached: 0, created: 1,
    serverStarted: 1, serverPid: 1, activity: 1, activePaneId: "%1",
    agentState: "waiting_human", agentStateReason: "test", agentStateChangedAt: 100,
    customTitle: null, tags: [], starred: false, ignored: false, queuedMessageCount: 0,
    panes: [], ...overrides,
  };
}

function pane(command: string, overrides: Partial<Pane> = {}): Pane {
  return {
    id: "%1", index: 0, window_index: 0, window_name: "main", window_active: true,
    active: true, command, path: "/project", title: "", width: 80, height: 24,
    history_size: 0, history_limit: 1000, alternate_on: false, dead: false, activity: 0,
    ...overrides,
  };
}

function message(overrides: Partial<CallbackMessage> = {}): CallbackMessage {
  return {
    id: "message-1", sequence: 1, sessionName: "one", message: "Ready for review",
    agentType: "codex", cwd: "/project", requestId: null, tmuxSessionId: null,
    tmuxPaneId: null, host: null, createdAt: 200, reviewedAt: null, ...overrides,
  };
}

function entry(name: string, overrides: Partial<CallbackListEntry> = {}): CallbackListEntry {
  return {
    name, session: session(name), messages: [], workspaceNames: [],
    inCurrentWorkspace: true, globalOnly: false, ...overrides,
  };
}

function view(
  entries: readonly CallbackListEntry[],
  preferences: Partial<CallbackListViewPreferences> = {},
  query = "",
): string[] {
  return filterAndSortCallbacks(entries, { ...DEFAULT_CALLBACK_LIST_VIEW, ...preferences }, query)
    .map((candidate) => candidate.name);
}

describe("callback list view", () => {
  it("preserves queue order and input rows without mutating the source", () => {
    const entries = [entry("z"), entry("a"), entry("m")];
    const result = filterAndSortCallbacks(entries, DEFAULT_CALLBACK_LIST_VIEW);
    expect(result).toEqual(entries);
    expect(result).not.toBe(entries);
    expect(result[0]).toBe(entries[0]);
    expect(view(entries, { sort: "name-asc" })).toEqual(["a", "m", "z"]);
    expect(entries.map((candidate) => candidate.name)).toEqual(["z", "a", "m"]);
  });

  it("puts ready sessions first while preserving order within ready and non-ready groups", () => {
    const entries = [
      entry("working", { session: session("working", { agentState: "working" }) }),
      entry("ready-later", { session: session("ready-later", { agentStateChangedAt: 400 }) }),
      entry("ended", { session: undefined }),
      entry("shell", { session: session("shell", { agentState: "other" }) }),
      entry("ready-earlier", { session: session("ready-earlier", { agentStateChangedAt: 200 }) }),
    ];
    expect(view(entries, { sort: "ready-first" }))
      .toEqual(["ready-later", "shell", "ready-earlier", "working", "ended"]);
  });

  it("sorts Ready longest by observed readiness, retaining undated ready rows before non-ready rows", () => {
    const entries = [
      entry("working", { session: session("working", { agentState: "working", agentStateChangedAt: 1 }) }),
      entry("undated", { session: session("undated", { agentStateChangedAt: 0 }) }),
      entry("new", { session: session("new", { agentStateChangedAt: 300 }) }),
      entry("shell", { session: session("shell", { agentState: "other", agentStateChangedAt: 1 }) }),
      entry("old", { session: session("old", { agentStateChangedAt: 100 }) }),
      entry("old-tie", { session: session("old-tie", { agentStateChangedAt: 100 }) }),
      entry("ended", { session: undefined }),
    ];
    expect(view(entries, { sort: "ready-longest" }))
      .toEqual(["old", "old-tie", "new", "undated", "shell", "working", "ended"]);
    expect(callbackEntryReadySince(entries[0])).toBeUndefined();
    expect(callbackEntryReadySince(entries[3])).toBeUndefined();
    expect(callbackEntryReadySince(entries[4])).toBe(100);
  });

  it.each([0, -1, NaN, Infinity, 1e20])("treats invalid timestamp %s as missing in both callback directions", (timestamp) => {
    const entries = [entry("invalid", { latestCallbackAt: timestamp }), entry("known", { latestCallbackAt: 100 })];
    expect(view(entries, { sort: "callback-newest" })).toEqual(["known", "invalid"]);
    expect(view(entries, { sort: "callback-oldest" })).toEqual(["known", "invalid"]);
    expect(callbackEntryReadySince(entry("invalid-ready", {
      session: session("invalid-ready", { agentStateChangedAt: timestamp }),
    }))).toBeUndefined();
  });

  it("sorts callback timestamps with stable ties and uses retained history or pending-message fallback", () => {
    const entries = [
      entry("undated"),
      entry("old", { latestCallbackAt: 100 }),
      entry("retained", { latestCallbackAt: 400, messages: [message({ createdAt: 50 })] }),
      entry("pending", { messages: [message({ createdAt: 200 }), message({ createdAt: 300 })] }),
      entry("old-tie", { latestCallbackAt: 100 }),
      entry("undated-tie"),
    ];
    expect(view(entries, { sort: "callback-newest" }))
      .toEqual(["retained", "pending", "old", "old-tie", "undated", "undated-tie"]);
    expect(view(entries, { sort: "callback-oldest" }))
      .toEqual(["old", "old-tie", "pending", "retained", "undated", "undated-tie"]);
    expect(callbackEntryLatestCallbackAt(entry("fallback", {
      latestCallbackAt: NaN, messages: [message({ createdAt: Infinity }), message({ createdAt: 90 })],
    }))).toBe(90);
  });

  it("sorts by visible titles naturally, falling back to session names and preserving equivalent titles", () => {
    const entries = [
      entry("ten", { session: session("ten", { customTitle: "  Agent 10  " }) }),
      entry("two", { session: session("two", { customTitle: "agent 2" }) }),
      entry("tie", { session: session("tie", { customTitle: "AGENT 2" }) }),
      entry("Agent 1", { session: session("Agent 1", { customTitle: "  " }) }),
      entry("Agent 3", { session: undefined }),
    ];
    expect(view(entries, { sort: "name-asc" })).toEqual(["Agent 1", "two", "tie", "Agent 3", "ten"]);
    expect(view(entries, { sort: "name-desc" })).toEqual(["ten", "Agent 3", "two", "tie", "Agent 1"]);
  });

  it("keeps live status semantics for ready, commands, waiting, unknown, and ended callbacks", () => {
    const entries = [
      entry("ready"),
      entry("shell", { session: session("shell", { agentState: "other" }) }),
      entry("working", { session: session("working", { agentState: "working" }) }),
      entry("command", { session: session("command", { agentState: "running_command" }) }),
      entry("waiting", { session: session("waiting", { agentState: "waiting_command" }) }),
      entry("unknown", { session: session("unknown", { agentState: "unknown" }) }),
      entry("ended", { session: undefined, messages: [message()] }),
    ];
    expect(view(entries, { status: "ready" })).toEqual(["ready", "shell"]);
    expect(view(entries, { status: "working" })).toEqual(["working", "command"]);
    expect(view(entries, { status: "waiting" })).toEqual(["waiting"]);
    expect(view(entries, { status: "unknown" })).toEqual(["unknown"]);
    expect(view(entries, { status: "ended" })).toEqual(["ended"]);
    expect(callbackStatus(entries[3].session))
      .toEqual({ label: "Command running", tone: "running_command", working: true });
    expect(callbackStatus(undefined))
      .toEqual({ label: "Ended / unavailable", tone: "ended", working: false });
  });

  it("combines message, location, status, and agent filters without stripping messages from a matching row", () => {
    const target = entry("target", {
      session: session("target", { agentType: "claude" }),
      messages: [message({ agentType: "codex" }), message({ agentType: "grok" })],
      inCurrentWorkspace: false, globalOnly: true,
    });
    const entries = [target, entry("empty"), entry("current", { messages: [message()] })];
    const preferences: CallbackListViewPreferences = {
      ...DEFAULT_CALLBACK_LIST_VIEW, status: "ready", agent: "codex", messages: "with-messages", location: "other",
    };
    const result = filterAndSortCallbacks(entries, preferences);
    expect(result).toEqual([target]);
    expect(result[0].messages).toBe(target.messages);
    expect(view(entries, { location: "current" })).toEqual(["empty", "current"]);
    expect(view(entries, { location: "global-only" })).toEqual(["target"]);
    expect(view(entries, { messages: "without-messages" })).toEqual(["empty"]);
    expect(view(entries, { agent: "claude" })).toEqual(["target"]);
  });

  it("finds ended or changed-agent callbacks by their pending message's agent", () => {
    const entries = [
      entry("ended", { session: undefined, messages: [message({ agentType: "Claude" })] }),
      entry("changed", { session: session("changed", { agentType: "codex" }), messages: [message({ agentType: "claude" })] }),
      entry("new-agent", { session: undefined, messages: [message({ agentType: "opencode" })] }),
      entry("unknown", { session: undefined }),
    ];
    expect(view(entries, { agent: "claude" })).toEqual(["ended", "changed"]);
    expect(view(entries, { agent: "codex" })).toEqual(["changed"]);
    expect(view(entries, { agent: "other" })).toEqual(["new-agent", "unknown"]);
  });

  it("infers agent type from the active pane only when live agent metadata is absent", () => {
    const entries = [
      entry("active", { session: session("active", {
        activePaneId: "%2", panes: [pane("bash"), pane("codex", { id: "%2" })],
      }) }),
      entry("copilot", { session: session("copilot", { panes: [pane("node", { title: "GitHub Copilot" })] }) }),
      entry("metadata", { session: session("metadata", { agentType: "claude", panes: [pane("codex")] }) }),
      entry("fallback", { session: session("fallback", { activePaneId: "%absent", panes: [pane("bash")] }) }),
    ];
    expect(view(entries, { agent: "codex" })).toEqual(["active"]);
    expect(view(entries, { agent: "copilot" })).toEqual(["copilot"]);
    expect(view(entries, { agent: "claude" })).toEqual(["metadata"]);
    expect(view(entries, { agent: "shells" })).toEqual(["fallback"]);
  });

  it("requires every case-insensitive query token across names, titles, workspaces, paths, and messages", () => {
    const target = entry("tmux-42", {
      session: session("tmux-42", { customTitle: "Release checks", agentType: "claude" }),
      workspaceNames: ["Launch room"],
      messages: [message({ message: "Regression fixed", cwd: "/srv/web-console", agentType: "codex" })],
    });
    const entries = [target, entry("unrelated", { messages: [message({ message: "Regression fixed" })] })];
    expect(view(entries, {}, "  REGRESSION\t42\nLaunch /srv/web Release claude codex  ")).toEqual(["tmux-42"]);
    expect(view(entries, {}, "Regression missing-token")).toEqual([]);
    expect(view(entries, {}, " \n ")).toEqual(["tmux-42", "unrelated"]);
    expect(view([entry("pane-path", { session: session("pane-path", {
      panes: [pane("codex", { path: "/srv/another-project" })],
    }) })], {}, "another-project")).toEqual(["pane-path"]);
  });
});

describe("callback list view preferences", () => {
  it.each([null, "{bad json", "null", "[]", "42", '"queue"'])("falls back safely for malformed storage %s", (raw) => {
    const result = parseCallbackListViewPreferences(raw);
    expect(result).toEqual(DEFAULT_CALLBACK_LIST_VIEW);
    expect(result).not.toBe(DEFAULT_CALLBACK_LIST_VIEW);
  });

  it("keeps known preferences and replaces invalid individual values without retaining query text", () => {
    expect(validateCallbackListViewPreferences({
      sort: "ready-longest", status: "working", agent: "future-agent", messages: "with-messages",
      location: 3, query: "secret draft", unexpected: true,
    })).toEqual({
      sort: "ready-longest", status: "working", agent: "all", messages: "with-messages", location: "all",
    });
    expect(parseCallbackListViewPreferences(JSON.stringify({ sort: "name-desc" })))
      .toEqual({ ...DEFAULT_CALLBACK_LIST_VIEW, sort: "name-desc" });
  });
});
