import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { listQueuedMessages, listSessions, updateSessionTitle } from "../api";
import type { Pane, Session } from "../types";
import { ConsoleScreen } from "./ConsoleScreen";

vi.mock("../api", () => ({
  listSessions: vi.fn(),
  listQueuedMessages: vi.fn(),
  createQueuedMessage: vi.fn(),
  updateQueuedMessage: vi.fn(),
  deleteQueuedMessage: vi.fn(),
  updateSessionStar: vi.fn(),
  updateSessionTitle: vi.fn(),
}));

vi.mock("./LiveTerminal", () => ({
  LiveTerminal: () => <div data-testid="live-terminal" />,
}));

function pane(): Pane {
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
    history_limit: 2000,
    alternate_on: false,
    dead: false,
    activity: 1,
  };
}

function session(customTitle: string | null = null): Session {
  return {
    name: "test",
    id: "$1",
    windows: 1,
    attached: 0,
    created: 1,
    activity: 1,
    activePaneId: "%1",
    agentState: "other",
    agentStateReason: "No agent",
    agentStateChangedAt: 1,
    customTitle,
    starred: false,
    queuedMessageCount: 0,
    panes: [pane()],
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  document.title = "Muxdeck";
});

describe("ConsoleScreen session title", () => {
  it("updates the human title from the bottom shortcut bar", async () => {
    vi.mocked(listSessions).mockResolvedValue([session()]);
    vi.mocked(updateSessionTitle).mockResolvedValue("Mobile work");
    render(<ConsoleScreen sessionName="test" onBack={vi.fn()} />);

    await screen.findByRole("heading", { name: "test" });
    fireEvent.click(screen.getByRole("button", { name: "Update session name" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Human title" }), {
      target: { value: "Mobile work" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save title" }));

    await waitFor(() => expect(updateSessionTitle).toHaveBeenCalledWith("test", "Mobile work"));
    expect(await screen.findByRole("heading", { name: "Mobile work" })).toBeVisible();
    expect(screen.getByText("test / /work")).toBeVisible();
    expect(document.title).toBe("Mobile work - Muxdeck");
    expect(screen.queryByRole("dialog", { name: "Name this work" })).not.toBeInTheDocument();
  });

  it("clears the human title without renaming the tmux session", async () => {
    vi.mocked(listSessions).mockResolvedValue([session("Old label")]);
    vi.mocked(updateSessionTitle).mockResolvedValue(null);
    render(<ConsoleScreen sessionName="test" onBack={vi.fn()} />);

    await screen.findByRole("heading", { name: "Old label" });
    fireEvent.click(screen.getByRole("button", { name: "Update session name" }));
    const titleDialog = screen.getByRole("dialog", { name: "Name this work" });
    fireEvent.click(within(titleDialog).getByRole("button", { name: "Clear" }));
    fireEvent.click(screen.getByRole("button", { name: "Save title" }));

    await waitFor(() => expect(updateSessionTitle).toHaveBeenCalledWith("test", ""));
    expect(await screen.findByRole("heading", { name: "test" })).toBeVisible();
    expect(document.title).toBe("test - Muxdeck");
  });

  it("loads a queued memorandum into the permanent staged input", async () => {
    vi.mocked(listSessions).mockResolvedValue([session()]);
    vi.mocked(listQueuedMessages).mockResolvedValue({
      session: "test",
      messages: [{
        id: "memo-1",
        text: "Review the latest test failure",
        createdAt: 1_700_000_000_000,
        updatedAt: 1_700_000_000_000,
        position: 0,
      }],
    });
    render(<ConsoleScreen sessionName="test" onBack={vi.fn()} />);

    await screen.findByRole("heading", { name: "test" });
    fireEvent.click(screen.getByRole("button", { name: "Open memoranda" }));
    expect(await screen.findByText("Review the latest test failure")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Use" }));

    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Queued messages" })).not.toBeInTheDocument());
    expect(screen.getByRole("textbox", { name: "Staged input" })).toHaveValue("Review the latest test failure");
  });
});
