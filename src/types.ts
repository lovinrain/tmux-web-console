export interface Pane {
  id: string;
  index: number;
  window_index: number;
  window_name: string;
  window_active: boolean;
  active: boolean;
  command: string;
  path: string;
  title: string;
  width: number;
  height: number;
  history_size: number;
  history_limit: number;
  alternate_on: boolean;
  dead: boolean;
  activity: number;
}

export const SESSION_TAGS = [
  "work",
  "review",
  "research",
  "urgent",
  "blocked",
  "background",
] as const;

export type SessionTag = typeof SESSION_TAGS[number];

export const SESSION_TAG_LABELS: Readonly<Record<SessionTag, string>> = {
  work: "Work",
  review: "Review",
  research: "Research",
  urgent: "Urgent",
  blocked: "Blocked",
  background: "Background",
};

export interface Session {
  name: string;
  id: string;
  windows: number;
  attached: number;
  created: number;
  serverStarted: number;
  serverPid: number;
  activity: number;
  activePaneId: string | null;
  agentState: AgentState;
  agentStateReason: string;
  agentStateChangedAt: number;
  /** Passive recovery metadata only; never an instruction to resume an agent. */
  agentType?: "claude" | "codex" | "copilot" | "cursor" | "grok" | null;
  agentSessionId?: string | null;
  customTitle: string | null;
  tags: SessionTag[];
  starred: boolean;
  ignored: boolean;
  workspacePinned?: boolean;
  queuedMessageCount: number;
  memorandumCount?: number;
  panes: Pane[];
}

export type AgentState =
  | "working"
  | "waiting_human"
  | "waiting_command"
  | "unknown"
  | "other";

export interface HistoryPage {
  snapshotId: string;
  paneId: string;
  capturedAt: number;
  lines: string[];
  nextCursor: number | null;
  totalLines: number;
  historySize: number;
  historyLimit: number;
  alternateOn: boolean;
}

export type MemorandumState = "note" | "queued";

export interface QueuedMessage {
  id: string;
  text: string;
  state: MemorandumState;
  createdAt: number;
  updatedAt: number;
  position: number;
}

export interface MessageQueue {
  session: string;
  messages: QueuedMessage[];
}

export interface SnippetFolder {
  id: string;
  type: "folder";
  name: string;
  children: SnippetNode[];
}

export interface SnippetLeaf {
  id: string;
  type: "snippet";
  name: string;
  text: string;
}

export type SnippetNode = SnippetFolder | SnippetLeaf;

export interface SnippetTree {
  tree: SnippetNode[];
  revision: number;
}

export type ConnectionState =
  | "connecting"
  | "live"
  | "reconnecting"
  | "disconnected"
  | "ended"
  | "error";
