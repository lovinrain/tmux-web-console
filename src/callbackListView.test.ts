import { describe, expect, it } from "vitest";
import type { CallbackMessage } from "./api";
import {
  CALLBACK_GROUP_OPTIONS,
  DEFAULT_CALLBACK_LIST_VIEW,
  callbackEntryLatestCallbackAt,
  callbackEntryReadySince,
  callbackStatus,
  filterAndSortCallbacks,
  groupCallbacks,
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

describe("callback list grouping", () => {
  it("keeps an ungrouped list in order and emits no empty groups", () => {
    const entries = Object.freeze([entry("z"), entry("a")]);
    const groups = groupCallbacks(entries, "none");
    expect(groups).toEqual([{ key: "none", label: "All callbacks", entries }]);
    expect(groups[0].entries).not.toBe(entries);
    expect(groups[0].entries[0]).toBe(entries[0]);
    for (const { value } of CALLBACK_GROUP_OPTIONS) expect(groupCallbacks([], value)).toEqual([]);
  });

  it("groups live statuses in priority order and combines running commands with working sessions", () => {
    const entries = [
      entry("ended", { session: undefined }),
      entry("unknown", { session: session("unknown", { agentState: "unknown" }) }),
      entry("waiting", { session: session("waiting", { agentState: "waiting_command" }) }),
      entry("command", { session: session("command", { agentState: "running_command" }) }),
      entry("ready"),
      entry("shell", { session: session("shell", { agentState: "other" }) }),
      entry("working", { session: session("working", { agentState: "working" }) }),
    ];
    const groups = groupCallbacks(entries, "status");
    expect(groups.map(({ label, tone, entries: rows }) => [label, tone, rows.map((row) => row.name)]))
      .toEqual([
        ["Ready", "ready", ["ready", "shell"]],
        ["Working", "working", ["command", "working"]],
        ["Waiting", "waiting", ["waiting"]],
        ["Status unknown", "unknown", ["unknown"]],
        ["Ended / unavailable", "ended", ["ended"]],
      ]);
    expect(groups.flatMap((group) => group.entries)).toHaveLength(entries.length);
  });

  it("preserves filtering and selected sort, including stable ties, within groups", () => {
    const entries = [
      entry("z", { session: session("z", { agentState: "working", customTitle: "Item 2" }) }),
      entry("hidden", { session: session("hidden", { customTitle: "Unrelated" }) }),
      entry("ready-late", { session: session("ready-late", { customTitle: "Item 10" }) }),
      entry("a", { session: session("a", { agentState: "working", customTitle: "Item 2" }) }),
      entry("ready-early", { session: session("ready-early", { customTitle: "Item 1" }) }),
    ];
    const filtered = filterAndSortCallbacks(entries, { ...DEFAULT_CALLBACK_LIST_VIEW, sort: "name-asc" }, "Item");
    const groups = groupCallbacks(filtered, "status");
    expect(groups.map((group) => group.entries.map((row) => row.name)))
      .toEqual([["ready-early", "ready-late"], ["z", "a"]]);
    expect(entries.map((row) => row.name)).toEqual(["z", "hidden", "ready-late", "a", "ready-early"]);
  });

  it("groups agents from live metadata, active panes, and pending messages in a fixed order", () => {
    const entries = [
      entry("unknown", { session: undefined }),
      entry("mixed", {
        session: session("mixed", { agentType: "codex" }), messages: [message({ agentType: "Claude" })],
      }),
      entry("shell", { session: session("shell", { panes: [pane("bash")] }) }),
      entry("grok", { session: session("grok", { agentType: "grok" }) }),
      entry("cursor", { session: session("cursor", { agentType: "cursor" }) }),
      entry("copilot", { session: session("copilot", { panes: [pane("node", { title: "GitHub Copilot" })] }) }),
      entry("codex", { session: session("codex", {
        activePaneId: "%2", panes: [pane("bash"), pane("codex", { id: "%2" })],
      }) }),
      entry("claude", { session: undefined, messages: [message({ agentType: "Claude" }), message({ agentType: "claude" })] }),
    ];
    const groups = groupCallbacks(entries, "agent");
    expect(groups.map((group) => group.label))
      .toEqual(["Claude", "Codex", "Copilot", "Cursor", "Grok", "Shells", "Multiple agents", "Other / unknown"]);
    expect(groups.map((group) => group.entries.map((row) => row.name)))
      .toEqual([["claude"], ["codex"], ["copilot"], ["cursor"], ["grok"], ["shell"], ["mixed"], ["unknown"]]);
  });

  it("keeps mixed-agent rows once when filtered by any of their agents", () => {
    const mixed = entry("mixed", {
      session: session("mixed", { agentType: "claude" }),
      messages: [message({ agentType: "codex" }), message({ agentType: "grok" })],
    });
    const codex = entry("codex", { session: session("codex", { agentType: "codex" }) });
    const filtered = filterAndSortCallbacks([mixed, codex], { ...DEFAULT_CALLBACK_LIST_VIEW, agent: "codex" });
    const groups = groupCallbacks(filtered, "agent");
    expect(groups.map((group) => [group.key, group.entries.map((row) => row.name)]))
      .toEqual([["agent:codex", ["codex"]], ["agent:multiple", ["mixed"]]]);
    expect(groups[1].entries[0].messages).toBe(mixed.messages);
  });

  it("distinguishes same-name workspaces by ID and puts shared sessions in one separate group", () => {
    const sources = Object.freeze([{ id: "room-b", name: "Room" }, { id: "room-a", name: "Room" }]);
    const entries = Object.freeze([
      entry("shared", { workspaceSources: sources }),
      entry("b", { workspaceSources: [sources[0]] }),
      entry("a", { workspaceSources: [sources[1], sources[1]] }),
      entry("global", { workspaceSources: [] }),
      entry("b-later", { workspaceSources: [sources[0]] }),
    ]);
    const groups = groupCallbacks(entries, "workspace");
    expect(groups.map((group) => [group.key, group.label, group.entries.map((row) => row.name)]))
      .toEqual([
        ["workspace:id:room-a", "Room", ["a"]],
        ["workspace:id:room-b", "Room", ["b", "b-later"]],
        ["workspace:multiple", "Multiple workspaces", ["shared"]],
        ["workspace:global", "Global queue", ["global"]],
      ]);
    expect(new Set(groups.flatMap((group) => group.entries))).toEqual(new Set(entries));
    expect(groups.flatMap((group) => group.entries)).toHaveLength(entries.length);
    expect(entries[0].workspaceSources).toBe(sources);
  });

  it("naturally orders workspace groups independently of callback order and preserves IDs after renaming", () => {
    const entries = [
      entry("ten", { workspaceSources: [{ id: "global", name: "Workspace 10" }] }),
      entry("two", { workspaceSources: [{ id: "multiple", name: "workspace 2" }] }),
      entry("first", { workspaceSources: [{ id: "one", name: "Workspace 1" }] }),
    ];
    const groups = groupCallbacks(entries, "workspace");
    expect(groups.map((group) => group.key))
      .toEqual(["workspace:id:one", "workspace:id:multiple", "workspace:id:global"]);
    expect(groupCallbacks([...entries].reverse(), "workspace").map((group) => group.key))
      .toEqual(groups.map((group) => group.key));
    expect(groupCallbacks([entry("renamed", { workspaceSources: [{ id: "one", name: "New name" }] })], "workspace"))
      .toMatchObject([{ key: "workspace:id:one", label: "New name" }]);
  });

  it("supports legacy workspace names while treating supplied sources as authoritative", () => {
    const entries = [
      entry("legacy", { workspaceNames: ["Legacy", "Legacy"] }),
      entry("legacy-shared", { workspaceNames: ["One", "Two"] }),
      entry("global", { workspaceNames: ["Stale name"], workspaceSources: [] }),
      entry("unnamed", { workspaceSources: [{ id: "untitled", name: "  " }] }),
    ];
    expect(groupCallbacks(entries, "workspace").map((group) => [group.key, group.label]))
      .toEqual([
        ["workspace:name:Legacy", "Legacy"],
        ["workspace:id:untitled", "Unnamed workspace"],
        ["workspace:multiple", "Multiple workspaces"],
        ["workspace:global", "Global queue"],
      ]);
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
      ...DEFAULT_CALLBACK_LIST_VIEW,
      sort: "ready-longest", status: "working", agent: "all", messages: "with-messages", location: "all",
    });
    expect(parseCallbackListViewPreferences(JSON.stringify({ sort: "name-desc" })))
      .toEqual({ ...DEFAULT_CALLBACK_LIST_VIEW, sort: "name-desc" });
  });

  it("restores grouping and independent collapse keys across grouping modes", () => {
    const preferences = {
      ...DEFAULT_CALLBACK_LIST_VIEW, group: "workspace",
      collapsedGroups: ["status:working", "agent:multiple", "workspace:id:team:1", "workspace:global"],
    };
    expect(parseCallbackListViewPreferences(JSON.stringify(preferences))).toEqual(preferences);
    expect(validateCallbackListViewPreferences({ group: "future-group" }))
      .toEqual(DEFAULT_CALLBACK_LIST_VIEW);
  });

  it("drops invalid collapse values and deduplicates keys without retaining the stored array", () => {
    const collapsedGroups = [
      "status:ready", "status:ready", "agent:codex", "workspace:multiple", "workspace:name:Old workspace",
      null, 42, {}, "", "none", "status:bad", "agent:all", "workspace:id:", "workspace:id:a\nb",
      `workspace:id:${"x".repeat(2048)}`,
    ];
    const result = validateCallbackListViewPreferences({ collapsedGroups });
    expect(result.collapsedGroups)
      .toEqual(["status:ready", "agent:codex", "workspace:multiple", "workspace:name:Old workspace"]);
    expect(result.collapsedGroups).not.toBe(collapsedGroups);
    expect(validateCallbackListViewPreferences({ collapsedGroups: "status:ready" }).collapsedGroups).toEqual([]);
    expect(validateCallbackListViewPreferences({ collapsedGroups: { "status:ready": true } }).collapsedGroups).toEqual([]);
  });

  it("bounds retained collapse keys and gives fallback preferences their own array", () => {
    const collapsedGroups = Array.from({ length: 600 }, (_, index) => `workspace:id:${index}`);
    expect(validateCallbackListViewPreferences({ collapsedGroups }).collapsedGroups).toEqual(collapsedGroups.slice(0, 512));
    const empty = parseCallbackListViewPreferences(null);
    empty.collapsedGroups.push("status:working");
    expect(DEFAULT_CALLBACK_LIST_VIEW.collapsedGroups).toEqual([]);
    expect(parseCallbackListViewPreferences("{bad").collapsedGroups).toEqual([]);
    expect(validateCallbackListViewPreferences(null).collapsedGroups).toEqual([]);
  });
});
