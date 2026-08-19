import { describe, expect, it } from "vitest";
import type { Pane, Session } from "./types";
import {
  canonicalizeSessionDashboardSearch,
  createDefaultSessionDashboardRoute,
  filterSessions,
  groupSessionsByTag,
  parseSessionDashboardSearch,
  serializeSessionDashboardSearch,
  sessionDisplayTitle,
  sessionStateChangedAt,
  sortSessions,
} from "./sessionDashboardModel";

function pane(overrides: Partial<Pane> = {}): Pane {
  return {
    id: "%1",
    index: 0,
    window_index: 0,
    window_name: "main",
    window_active: true,
    active: true,
    command: "bash",
    path: "/work",
    title: "shell",
    width: 100,
    height: 30,
    history_size: 0,
    history_limit: 2_000,
    alternate_on: false,
    dead: false,
    activity: 1,
    ...overrides,
  };
}

function session(overrides: Partial<Session> = {}): Session {
  return {
    name: "test",
    id: "$1",
    windows: 1,
    attached: 0,
    created: 1,
    serverStarted: 10,
    serverPid: 100,
    activity: 1,
    activePaneId: "%1",
    agentState: "other",
    agentStateReason: "No agent",
    agentStateChangedAt: 1,
    customTitle: null,
    starred: false,
    ignored: false,
    queuedMessageCount: 0,
    panes: [pane()],
    ...overrides,
    tags: overrides.tags ?? [],
  };
}

describe("session dashboard URL state", () => {
  it("uses existing dashboard behavior for an empty URL", () => {
    const parsed = parseSessionDashboardSearch("");
    expect(parsed).toEqual(createDefaultSessionDashboardRoute());
    expect(parsed.sort).toEqual(["activity", "tmux-name"]);
    expect(serializeSessionDashboardSearch(createDefaultSessionDashboardRoute())).toBe("");
  });

  it("round-trips ordered sort criteria and all shareable controls", () => {
    const state = parseSessionDashboardSearch(
      "?q=deploy&kind=codex&state=waiting_human&view=list&group=state"
      + "&sort=state&sort=title&sort=state-change",
    );

    expect(state).toEqual({
      query: "deploy",
      kind: "codex",
      state: "waiting_human",
      includedTags: [],
      excludedTags: [],
      view: "list",
      group: "state",
      sort: ["state", "title", "state-change"],
    });
    expect(serializeSessionDashboardSearch(state)).toBe(
      "?q=deploy&kind=codex&state=waiting_human&view=list&group=state"
      + "&sort=state,title,state-change",
    );
  });

  it("accepts comma-separated, aliased, and legacy values then canonicalizes them", () => {
    expect(canonicalizeSessionDashboardSearch(
      "?filter=agent&state=needs-input&view=grid&sort=state-groups,title",
    )).toBe("?kind=agents&state=waiting_human&group=state&sort=title");

    expect(canonicalizeSessionDashboardSearch("?sort=state-groups")).toBe(
      "?group=state&sort=state-change,tmux-name",
    );
    expect(canonicalizeSessionDashboardSearch("?kind=GROK")).toBe("?kind=grok");
    expect(canonicalizeSessionDashboardSearch("?kind=COPILOT")).toBe("?kind=copilot");
    for (const state of ["waiting_command", "command-wait", "background-work"]) {
      expect(canonicalizeSessionDashboardSearch(`?state=${state}`)).toBe(
        "?state=waiting_command",
      );
    }
  });

  it("drops invalid values and duplicate sort keys while preserving unrelated params", () => {
    expect(canonicalizeSessionDashboardSearch(
      "?utm=phone&kind=robot&state=asleep&view=table&group=color"
      + "&sort=nope&sort=title&sort=title&sort=tmux",
    )).toBe("?utm=phone&sort=title,tmux-name");

    expect(canonicalizeSessionDashboardSearch(
      "?kind=robot&state=asleep&view=table&sort=nope",
    )).toBe("");
  });

  it("uses fixed directions and preserves only criterion priority in the URL", () => {
    const state = createDefaultSessionDashboardRoute();
    state.sort = ["activity", "state"];
    expect(serializeSessionDashboardSearch(state)).toBe("?sort=activity,state");
  });

  it("canonicalizes included and excluded tags in predefined order", () => {
    const input = "?tab=alpha&workspace=saved-one&tag=URGENT&tag=work,review&tag=work"
      + "&not-tag=blocked&not-tag=urgent&not-tag=unknown&group=tags";
    const route = parseSessionDashboardSearch(input);

    expect(route.includedTags).toEqual(["work", "review"]);
    expect(route.excludedTags).toEqual(["urgent", "blocked"]);
    expect(route.group).toBe("tag");
    expect(canonicalizeSessionDashboardSearch(input)).toBe(
      "?tab=alpha&workspace=saved-one&tag=work&tag=review"
      + "&not-tag=urgent&not-tag=blocked&group=tag",
    );
  });
});

describe("ordered session sorting", () => {
  it("keeps activity newest-first and uses natural tmux name ties by default", () => {
    const sessions = [
      session({ name: "cx10", id: "$10", activity: 30 }),
      session({ name: "cx2", id: "$2", activity: 30 }),
      session({ name: "old", id: "$3", activity: 20 }),
    ];
    const sorted = sortSessions(sessions);

    expect(sorted.map((item) => item.name)).toEqual(["cx2", "cx10", "old"]);
    expect(sessions.map((item) => item.name)).toEqual(["cx10", "cx2", "old"]);
  });

  it("applies state first and human title second in badge order", () => {
    const sessions = [
      session({ name: "w-z", id: "$1", agentState: "working", customTitle: "Alpha" }),
      session({ name: "n-z", id: "$2", agentState: "waiting_human", customTitle: "Zulu" }),
      session({ name: "n-a", id: "$3", agentState: "waiting_human", customTitle: "Alpha" }),
      session({ name: "c-a", id: "$4", agentState: "waiting_command", customTitle: "Alpha" }),
    ];

    expect(sortSessions(sessions, ["state", "title"])
      .map((item) => item.name)).toEqual(["n-a", "n-z", "w-z", "c-a"]);
  });

  it("sorts title by human title with tmux-name fallback", () => {
    const sessions = [
      session({ name: "cx10", id: "$1", customTitle: null }),
      session({ name: "cx2", id: "$2", customTitle: "  " }),
      session({ name: "zzz", id: "$3", customTitle: "Build 2" }),
      session({ name: "aaa", id: "$4", customTitle: "Build 10" }),
    ];

    expect(sortSessions(sessions, ["title"])
      .map((item) => item.name)).toEqual(["zzz", "aaa", "cx2", "cx10"]);
    expect(sessionDisplayTitle(sessions[1])).toBe("cx2");
  });

  it("uses activity then creation as missing state-change fallbacks", () => {
    const sessions = [
      session({ name: "created", agentStateChangedAt: 0, activity: 0, created: 40 }),
      session({ name: "activity", agentStateChangedAt: 0, activity: 50, created: 1 }),
      session({ name: "changed", agentStateChangedAt: 60, activity: 1, created: 1 }),
    ];

    expect(sessionStateChangedAt(sessions[0])).toBe(40);
    expect(sortSessions(sessions, ["state-change"])
      .map((item) => item.name)).toEqual(["changed", "activity", "created"]);
  });

  it("uses tmux name and id as deterministic fallbacks after exact criterion ties", () => {
    const sessions = [
      session({ name: "same", id: "$2", customTitle: "One" }),
      session({ name: "same", id: "$1", customTitle: "One" }),
      session({ name: "other", id: "$3", customTitle: "One" }),
    ];

    expect(sortSessions(sessions, ["title"])
      .map((item) => item.id)).toEqual(["$3", "$1", "$2"]);
  });
});

describe("session dashboard filters", () => {
  it("applies the parsed kind, state, and text query to the active pane", () => {
    const sessions = [
      session({
        name: "one",
        agentState: "waiting_human",
        customTitle: "Deploy API",
        panes: [pane({ command: "codex", path: "/srv/api" })],
      }),
      session({
        name: "two",
        id: "$2",
        agentState: "working",
        panes: [pane({ command: "claude", path: "/srv/web" })],
      }),
    ];

    const route = parseSessionDashboardSearch("?q=api&kind=agents&state=waiting_human");
    expect(filterSessions(sessions, route).map((item) => item.name)).toEqual(["one"]);
  });

  it("treats Cursor, Copilot, and Grok panes as agents under their own chips and Agents", () => {
    const sessions = [
      session({ name: "cursor-one", panes: [pane({ command: "agent" })] }),
      session({ name: "cursor-two", id: "$2", panes: [pane({ command: "cursor-agent" })] }),
      session({ name: "codex-one", id: "$3", panes: [pane({ command: "codex" })] }),
      session({ name: "copilot-one", id: "$4", panes: [pane({ command: "copilot" })] }),
      session({
        name: "copilot-node-exact",
        id: "$5",
        panes: [pane({ command: "node", title: "GitHub Copilot" })],
      }),
      session({
        name: "copilot-node-suffix",
        id: "$6",
        panes: [pane({ command: "NODE", title: "~/repo - gItHuB CoPiLoT" })],
      }),
      session({ name: "not-copilot", id: "$7", panes: [pane({ command: "copilot-agent" })] }),
      session({
        name: "deceptive-node",
        id: "$8",
        panes: [pane({ command: "node", title: "GitHub Copilot - dashboard" })],
      }),
      session({
        name: "wrong-command",
        id: "$9",
        panes: [pane({ command: "bash", title: "GitHub Copilot" })],
      }),
      session({ name: "grok-one", id: "$10", panes: [pane({ command: "grok" })] }),
      session({ name: "tunnel", id: "$11", panes: [pane({ command: "ngrok" })] }),
      session({ name: "shell-one", id: "$12", panes: [pane({ command: "bash" })] }),
    ];
    const names = (search: string) =>
      filterSessions(sessions, parseSessionDashboardSearch(search)).map((item) => item.name);

    expect(names("?kind=cursor")).toEqual(["cursor-one", "cursor-two"]);
    expect(names("?kind=cursor-agent")).toEqual(["cursor-one", "cursor-two"]);
    expect(names("?kind=agents")).toEqual([
      "cursor-one",
      "cursor-two",
      "codex-one",
      "copilot-one",
      "copilot-node-exact",
      "copilot-node-suffix",
      "grok-one",
    ]);
    expect(names("?kind=codex")).toEqual(["codex-one"]);
    expect(names("?kind=copilot")).toEqual([
      "copilot-one",
      "copilot-node-exact",
      "copilot-node-suffix",
    ]);
    expect(names("?kind=grok")).toEqual(["grok-one"]);
    expect(names("?kind=shells")).toEqual(["wrong-command", "shell-one"]);
  });

  it("includes any selected tag, then removes every excluded match", () => {
    const sessions = [
      session({ name: "work", tags: ["work"] }),
      session({ name: "review", id: "$2", tags: ["review"] }),
      session({ name: "urgent-review", id: "$3", tags: ["review", "urgent"] }),
      session({ name: "untagged", id: "$4" }),
    ];
    const route = parseSessionDashboardSearch(
      "?tag=work&tag=review&not-tag=urgent",
    );

    expect(filterSessions(sessions, route).map((item) => item.name)).toEqual([
      "work",
      "review",
    ]);
  });

  it("finds sessions by tag name and groups multi-tag sessions without losing labels", () => {
    const sessions = [
      session({ name: "one", tags: ["work", "urgent"] }),
      session({ name: "two", id: "$2", tags: ["review"] }),
      session({ name: "three", id: "$3" }),
    ];

    expect(filterSessions(sessions, parseSessionDashboardSearch("?q=urgent"))
      .map((item) => item.name)).toEqual(["one"]);
    expect(groupSessionsByTag(sessions).map((group) => ({
      tag: group.tag,
      names: group.sessions.map((item) => item.name),
    }))).toEqual([
      { tag: "work", names: ["one"] },
      { tag: "review", names: ["two"] },
      { tag: "urgent", names: ["one"] },
      { tag: null, names: ["three"] },
    ]);
  });
});
