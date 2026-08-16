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

export interface Session {
  name: string;
  id: string;
  windows: number;
  attached: number;
  created: number;
  activity: number;
  activePaneId: string | null;
  agentState: AgentState;
  agentStateReason: string;
  agentStateChangedAt: number;
  customTitle: string | null;
  starred: boolean;
  ignored: boolean;
  queuedMessageCount: number;
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

export interface QueuedMessage {
  id: string;
  text: string;
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
