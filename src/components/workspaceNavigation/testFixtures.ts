import { vi } from "vitest";
import type { Pane, Session } from "../../types";
import type { SessionWorkspaceNavigationProps } from "./types";

export function pane(overrides: Partial<Pane> = {}): Pane {
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

export function session(overrides: Partial<Session> & Pick<Session, "name">): Session {
  return {
    id: `$${overrides.name}`,
    windows: 1,
    attached: 0,
    created: 1,
    serverStarted: 10,
    serverPid: 100,
    activity: 1,
    activePaneId: "%1",
    agentState: "other",
    agentStateReason: "No agent detected",
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

export const sessions: Session[] = [
  session({
    name: "alpha",
    customTitle: "Alpha control",
    activity: 40,
    agentState: "waiting_human",
    panes: [pane({ command: "codex", path: "/srv/alpha", title: "review" })],
  }),
  session({
    name: "beta",
    activity: 30,
    agentState: "working",
    panes: [pane({ command: "claude", path: "/srv/beta", title: "worker" })],
  }),
  session({
    name: "archive",
    customTitle: "Archived deploy",
    activity: 20,
    agentState: "waiting_command",
    panes: [pane({ command: "bash", path: "/srv/archive", title: "kubectl logs" })],
  }),
  session({
    name: "zulu",
    customTitle: "Zulu shell",
    activity: 10,
    panes: [pane({ command: "zsh", path: "/srv/zulu" })],
  }),
];


type NavigationProps = SessionWorkspaceNavigationProps;

export function navigationProps(overrides: Partial<NavigationProps> = {}): NavigationProps {
  return {
    activeSession: "alpha",
    openSessions: ["alpha", "beta"],
    recentSessions: ["alpha", "archive", "ended", "beta"],
    sessions,
    recentsOpen: false,
    onSelect: vi.fn(),
    onCloseTab: vi.fn(),
    onOpenRecents: vi.fn(),
    onCloseRecents: vi.fn(),
    onClearRecents: vi.fn(),
    onOpenDashboard: vi.fn(),
    ...overrides,
  };
}
