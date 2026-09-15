import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RecoverableSession } from "../api";
import type { Pane, Session } from "../types";
import {
  WorkspaceSessionAddDialog,
  rankAddableEntries,
  rankAddableSessions,
} from "./WorkspaceSessionAddDialog";

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

function session(name: string, overrides: Partial<Session> = {}): Session {
  return {
    name,
    id: `$${name}`,
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
    tags: [],
    starred: false,
    ignored: false,
    queuedMessageCount: 0,
    panes: [pane()],
    ...overrides,
  };
}

const sessions = [
  session("already-open", { customTitle: "Existing tab", activity: 100 }),
  session("model-lab", {
    customTitle: "Model Lab Worker",
    activity: 30,
    agentState: "working",
    agentStateReason: "Claude is generating output",
    panes: [pane({ command: "claude", path: "/srv/model-lab" })],
  }),
  session("release-review", {
    customTitle: "Release Review",
    starred: true,
    activity: 20,
    agentState: "waiting_human",
    tags: ["review"],
    panes: [pane({ command: "codex", path: "/srv/release" })],
  }),
  session("ignored-shell", {
    ignored: true,
    starred: true,
    activity: 200,
    panes: [pane({ path: "/tmp/archive" })],
  }),
];

beforeEach(() => {
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  });
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  document.body.style.overflow = "";
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.style.overflow = "";
});

describe("rankAddableSessions", () => {
  it("excludes open tabs, ranks useful sessions first, and fuzzily searches metadata", () => {
    expect(rankAddableSessions(sessions, ["already-open"], "").map(({ session: item }) => (
      item.name
    ))).toEqual(["release-review", "model-lab", "ignored-shell"]);

    expect(rankAddableSessions(sessions, [], "ml wrk").map(({ session: item }) => (
      item.name
    ))).toEqual(["model-lab"]);
    expect(rankAddableSessions(sessions, [], "srv rel codx")[0]?.session.name)
      .toBe("release-review");
    expect(rankAddableSessions(sessions, [], "needs input")[0]?.session.name)
      .toBe("release-review");
  });
});

function recovery(
  name: string,
  overrides: Partial<RecoverableSession> = {},
): RecoverableSession {
  return {
    id: `registry-${name}`,
    name,
    directory: `/srv/${name}`,
    agentType: null,
    agentSessionId: null,
    firstSeenAt: 1,
    lastSeenAt: 50,
    directoryAvailable: true,
    ...overrides,
  };
}

const missing = [
  recovery("model-archive", { agentType: "claude", lastSeenAt: 90 }),
  recovery("release-archive", { lastSeenAt: 10 }),
];

describe("rankAddableEntries", () => {
  it("searches live and missing shells together, live first", () => {
    const ranked = rankAddableEntries(sessions, missing, ["already-open"], "");
    expect(ranked.map(({ entry }) => `${entry.kind}:${entry.name}`)).toEqual([
      "live:release-review",
      "live:model-lab",
      "live:ignored-shell",
      "missing:model-archive",
      "missing:release-archive",
    ]);
  });

  it("matches missing shells on name, directory, and agent", () => {
    expect(rankAddableEntries([], missing, [], "archive").map(({ entry }) => entry.name))
      .toEqual(["model-archive", "release-archive"]);
    expect(rankAddableEntries([], missing, [], "srv release").map(({ entry }) => entry.name))
      .toEqual(["release-archive"]);
    expect(rankAddableEntries([], missing, [], "claude").map(({ entry }) => entry.name))
      .toEqual(["model-archive"]);
  });

  it("never offers a tab that is already open or already live", () => {
    expect(rankAddableEntries([], missing, ["model-archive"], "").map(({ entry }) => entry.name))
      .toEqual(["release-archive"]);
    // A recreated shell appears in both lists; it must not be duplicated.
    const live = [session("model-archive")];
    expect(rankAddableEntries(live, missing, [], "model-archive")
      .map(({ entry }) => `${entry.kind}:${entry.name}`))
      .toEqual(["live:model-archive"]);
  });
});

describe("WorkspaceSessionAddDialog", () => {
  it("lists missing shells alongside live ones and recreates them", async () => {
    const onRecreate = vi.fn();
    render(
      <WorkspaceSessionAddDialog
        sessions={sessions}
        openSessions={["already-open"]}
        recoverableSessions={[
          ...missing,
          recovery("no-directory", { directoryAvailable: false }),
        ]}
        onAdd={vi.fn()}
        onRecreate={onRecreate}
        onClose={vi.fn()}
      />,
    );

    const dialog = screen.getByRole("dialog", { name: "Add running sessions" });
    const search = within(dialog).getByRole("combobox", { name: "Find a session to add" });
    fireEvent.change(search, { target: { value: "archive" } });

    expect(within(dialog).getByText("model-archive")).toBeVisible();
    expect(within(dialog).getAllByText("Missing").length).toBeGreaterThan(0);

    fireEvent.click(within(dialog).getByRole("button", { name: "Recreate model-archive" }));
    expect(onRecreate).toHaveBeenCalledWith("model-archive");

    // A shell whose saved directory is gone cannot be recreated.
    fireEvent.change(search, { target: { value: "no-directory" } });
    expect(within(dialog).getByRole("button", { name: "Recreate no-directory" })).toBeDisabled();
  });

  it("still adds a missing shell back as a tab", () => {
    const onAdd = vi.fn();
    render(
      <WorkspaceSessionAddDialog
        sessions={[]}
        openSessions={[]}
        recoverableSessions={missing}
        onAdd={onAdd}
        onClose={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Add model-archive to workspace" }));
    expect(onAdd).toHaveBeenCalledWith("model-archive", false);
  });

  it("keeps the picker open for repeated adds and filters newly added sessions", async () => {
    const onAdd = vi.fn();
    function Harness() {
      const [openSessions, setOpenSessions] = useState(["already-open"]);
      return (
        <WorkspaceSessionAddDialog
          sessions={sessions}
          openSessions={openSessions}
          workspaceName="Research desk"
          onAdd={(name, open) => {
            onAdd(name, open);
            setOpenSessions((current) => [...current, name]);
          }}
          onClose={vi.fn()}
        />
      );
    }

    render(<Harness />);
    const dialog = screen.getByRole("dialog", { name: "Add running sessions" });
    expect(within(dialog).getByText("3 available for Research desk")).toBeVisible();
    expect(within(dialog).queryByText("Existing tab")).not.toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole("button", {
      name: "Add release-review to workspace",
    }));
    expect(onAdd).toHaveBeenCalledWith("release-review", false);
    expect(dialog).toBeVisible();
    await waitFor(() => {
      expect(within(dialog).queryByText("Release Review")).not.toBeInTheDocument();
    });
    expect(within(dialog).getByRole("status")).toHaveTextContent(
      "Added Release Review to the workspace.",
    );
  });

  it("supports fuzzy search, arrow selection, Enter, and add-and-open", async () => {
    const onAdd = vi.fn();
    const onClose = vi.fn();
    render(
      <WorkspaceSessionAddDialog
        sessions={sessions}
        openSessions={["already-open"]}
        onAdd={onAdd}
        onClose={onClose}
      />,
    );

    const dialog = screen.getByRole("dialog", { name: "Add running sessions" });
    const search = within(dialog).getByRole("combobox", { name: "Find a session to add" });
    await waitFor(() => expect(search).toHaveFocus());
    fireEvent.change(search, { target: { value: "srv" } });
    expect(within(dialog).getByText("Release Review")).toBeVisible();
    expect(within(dialog).getByText("Model Lab Worker")).toBeVisible();

    fireEvent.keyDown(search, { key: "ArrowDown" });
    fireEvent.keyDown(search, { key: "Enter", shiftKey: true });
    expect(onClose).toHaveBeenCalledOnce();
    expect(onAdd).toHaveBeenCalledWith("model-lab", true);
  });

  it("disables additions when the workspace is full", () => {
    render(
      <WorkspaceSessionAddDialog
        sessions={sessions}
        openSessions={["already-open"]}
        workspaceFull
        onAdd={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByRole("alert")).toHaveTextContent("This workspace is full");
    expect(screen.getAllByRole("button", { name: /^Add .* to workspace$/ }))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ disabled: true }),
      ]));
  });
});
