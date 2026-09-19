import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { useState, type ComponentProps } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createSession,
  createWorkspace,
  listWorkspaces,
  recreateSession,
  terminateSession,
  updateWorkspace,
  type RecoverableSession,
} from "../api";
import { renderWithTheme } from "../test-utils";
import { ThemeProvider } from "../theme";
import type { Session } from "../types";
import type { ConsoleScreen } from "./ConsoleScreen";
import { EphemeralSessionScreen } from "./EphemeralSessionScreen";

const consoleState = vi.hoisted(() => ({
  props: null as ComponentProps<typeof ConsoleScreen> | null,
}));

vi.mock("../api", () => ({
  recoverableSessionsFromList: (sessions: Session[] & { recoverableSessions?: RecoverableSession[] }) => (
    sessions.recoverableSessions ?? []
  ),
  recreateSession: vi.fn(),
  terminateSession: vi.fn(),
  createSession: vi.fn(),
  createWorkspace: vi.fn(),
  listWorkspaces: vi.fn(),
  updateWorkspace: vi.fn(),
}));

vi.mock("./ConsoleScreen", () => ({
  ConsoleScreen: (props: ComponentProps<typeof ConsoleScreen>) => {
    consoleState.props = props;
    return <div data-testid="session-console" data-ended={props.sessionSnapshot === null}>
      <h1>{props.sessionName}</h1>
      <button onClick={props.onBack}>Close tab</button>
      {props.onRecreateSession && <button
        disabled={props.recreateSessionBusy}
        onClick={() => void props.onRecreateSession?.()}
      >Recreate shell</button>}
      {props.renameWarning && <div role="alert">
        {props.renameWarning.messages.join("; ")}
        <button onClick={() => props.onDismissRenameWarning?.(props.renameWarning!.sessionId)}>
          Dismiss rename warning
        </button>
      </div>}
    </div>;
  },
}));

function session(name = "shell", changes: Partial<Session> = {}): Session {
  return {
    name,
    id: "$1",
    windows: 1,
    attached: 0,
    created: 20,
    serverStarted: 10,
    serverPid: 100,
    activity: 30,
    activePaneId: "%1",
    agentState: "other",
    agentStateReason: "Shell",
    agentStateChangedAt: 30,
    customTitle: null,
    tags: [],
    starred: false,
    ignored: false,
    queuedMessageCount: 0,
    panes: [],
    ...changes,
  };
}

const recovery: RecoverableSession = {
  id: "recovery-1",
  name: "shell",
  directory: "/work",
  directoryAvailable: true,
  agentType: null,
  agentSessionId: null,
  firstSeenAt: 20,
  lastSeenAt: 30,
};

function receive(sessions: Session[], recoverableSessions: RecoverableSession[] = []) {
  act(() => consoleState.props!.onSessionsChange!(Object.assign(sessions, { recoverableSessions })));
}

function RoutedScreen() {
  const [name, setName] = useState("shell");
  return <EphemeralSessionScreen sessionName={name} onSessionRenamed={setName} />;
}

beforeEach(() => {
  vi.resetAllMocks();
  consoleState.props = null;
  window.localStorage.clear();
  window.sessionStorage.clear();
  vi.mocked(terminateSession).mockResolvedValue(undefined);
  vi.mocked(recreateSession).mockResolvedValue({ name: "shell", id: "$2" });
});

describe("EphemeralSessionScreen", () => {
  it("attaches to just the requested session without workspace props, storage, or creation", () => {
    window.localStorage.setItem("muxdeck.workspace", "saved workspace state");
    window.sessionStorage.setItem("muxdeck.workspace", "temporary workspace state");
    const view = renderWithTheme(<RoutedScreen />);
    receive([session()]);

    expect(screen.getByRole("heading", { name: "shell" })).toBeInTheDocument();
    expect(consoleState.props).toMatchObject({ ephemeral: true, sessionName: "shell" });
    for (const key of ["workspaceId", "workspaceName", "sessionNavigation", "headerNotes", "workspaceLinks",
      "onSplitWorkspace", "onSessionWorkspaceTransfer", "onForgetSession"]) {
      expect(consoleState.props).not.toHaveProperty(key);
    }
    view.unmount();
    expect(window.localStorage.getItem("muxdeck.workspace")).toBe("saved workspace state");
    expect(window.sessionStorage.getItem("muxdeck.workspace")).toBe("temporary workspace state");
    for (const request of [createSession, createWorkspace, listWorkspaces, updateWorkspace,
      recreateSession, terminateSession]) expect(request).not.toHaveBeenCalled();
  });

  it("follows an externally renamed session by complete identity even when its old name is reused", () => {
    renderWithTheme(<RoutedScreen />);
    receive([session()]);
    receive([session("shell", { id: "$2", created: 40 }), session("renamed")]);
    expect(screen.getByRole("heading", { name: "renamed" })).toBeInTheDocument();
    expect(updateWorkspace).not.toHaveBeenCalled();
  });

  it.each([
    { created: 21 },
    { serverStarted: 11 },
    { serverPid: 101 },
  ])("does not follow a reused tmux ID with different host/session identity %j", (identity) => {
    const navigate = vi.fn();
    renderWithTheme(<EphemeralSessionScreen sessionName="shell" onSessionRenamed={navigate} />);
    receive([session()]);
    receive([session("different-session", identity)]);
    expect(navigate).not.toHaveBeenCalled();
  });

  it("keeps rename warnings and ignores an inventory request predating the local rename", () => {
    renderWithTheme(<RoutedScreen />);
    receive([session()]);
    act(() => consoleState.props!.onSessionRenamed!("shell", "renamed", "$1", ["Metadata needs attention"]));
    receive([session()]);
    expect(screen.getByRole("heading", { name: "renamed" })).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("Metadata needs attention");
    receive([session("renamed")]);
    receive([session("renamed-again")]);
    expect(screen.getByRole("heading", { name: "renamed-again" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss rename warning" }));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("starts following the new target after navigation to a different session", () => {
    const navigate = vi.fn();
    const view = renderWithTheme(<EphemeralSessionScreen sessionName="shell" onSessionRenamed={navigate} />);
    receive([session()]);
    view.rerender(<ThemeProvider><EphemeralSessionScreen sessionName="another" onSessionRenamed={navigate} /></ThemeProvider>);
    receive([session("old-renamed"), session("another", { id: "$2" })]);
    expect(navigate).not.toHaveBeenCalled();
    receive([session("another-renamed", { id: "$2" })]);
    expect(navigate).toHaveBeenCalledWith("another-renamed");
  });

  it("only recreates a missing shell after the explicit action and keeps it session-only", async () => {
    renderWithTheme(<RoutedScreen />);
    receive([], [recovery]);
    expect(recreateSession).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Recreate shell" }));
    await waitFor(() => expect(recreateSession).toHaveBeenCalledWith("recovery-1", expect.any(String)));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Recreate shell" })).not.toBeInTheDocument());
    expect(screen.getByRole("heading", { name: "shell" })).toBeInTheDocument();
    expect(consoleState.props!.sessionSnapshot).toBeUndefined();
    expect(createSession).not.toHaveBeenCalled();
    expect(createWorkspace).not.toHaveBeenCalled();
    expect(updateWorkspace).not.toHaveBeenCalled();
  });

  it("shows a failed recreate request and permits a retry", async () => {
    vi.mocked(recreateSession).mockRejectedValueOnce(new Error("Saved directory unavailable"));
    renderWithTheme(<RoutedScreen />);
    receive([], [recovery]);
    fireEvent.click(screen.getByRole("button", { name: "Recreate shell" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Saved directory unavailable");
    expect(screen.getByRole("button", { name: "Recreate shell" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Recreate shell" }));
    await waitFor(() => expect(recreateSession).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
  });

  it("explicit termination uses full identity and leaves an ended session page", async () => {
    const navigate = vi.fn();
    renderWithTheme(<EphemeralSessionScreen sessionName="shell" onSessionRenamed={navigate} />);
    receive([session()]);
    await act(async () => consoleState.props!.onSessionTerminated!("shell", "$1", 20, 10, 100));
    expect(terminateSession).toHaveBeenCalledWith("shell", "$1", 20, 10, 100);
    expect(screen.getByTestId("session-console")).toHaveAttribute("data-ended", "true");
    expect(screen.getByRole("heading", { name: "shell" })).toBeInTheDocument();
    expect(navigate).not.toHaveBeenCalled();
    expect(updateWorkspace).not.toHaveBeenCalled();
    expect(recreateSession).not.toHaveBeenCalled();
  });

  it("leaves a failed termination to the confirmation dialog without detaching the session", async () => {
    vi.mocked(terminateSession).mockRejectedValue(new Error("Session identity changed"));
    renderWithTheme(<RoutedScreen />);
    receive([session()]);
    await act(async () => {
      await expect(consoleState.props!.onSessionTerminated!("shell", "$1", 20, 10, 100))
        .rejects.toThrow("Session identity changed");
    });
    expect(screen.getByTestId("session-console")).toHaveAttribute("data-ended", "false");
  });

  it("closing the browser tab only detaches and explains when a manual tab cannot close itself", () => {
    const close = vi.spyOn(window, "close").mockImplementation(() => {});
    const view = renderWithTheme(<RoutedScreen />);
    receive([session()]);
    fireEvent.click(screen.getByRole("button", { name: "Close tab" }));
    expect(close).toHaveBeenCalledOnce();
    expect(screen.getByRole("status")).toHaveTextContent("The tmux session will keep running");
    view.unmount();
    expect(terminateSession).not.toHaveBeenCalled();
    expect(updateWorkspace).not.toHaveBeenCalled();
    close.mockRestore();
  });
});
