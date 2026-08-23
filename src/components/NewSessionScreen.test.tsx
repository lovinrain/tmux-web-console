import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSession, listSessions } from "../api";
import { renderWithTheme } from "../test-utils";
import type { Session } from "../types";
import {
  NEW_SESSION_DIRECTORIES_STORAGE_KEY,
  NEW_SESSION_WORKSPACE_MEMORY_STORAGE_KEY,
  NEW_SESSION_PANEL_ID,
  NewSessionScreen,
} from "./NewSessionScreen";

vi.mock("../api", () => ({
  createSession: vi.fn(),
  listSessions: vi.fn(),
}));

function deferredSession() {
  let resolve!: (session: { name: string; id: string }) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<{ name: string; id: string }>((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  return { promise, reject, resolve };
}

function sessionWorkspace(
  name: string,
  id: string,
  path: string,
  activity: number,
): Session {
  return {
    name,
    id,
    windows: 1,
    attached: 0,
    created: activity - 100,
    serverStarted: 1,
    serverPid: 100,
    activity,
    activePaneId: `%${id.replace("$", "")}`,
    agentState: "other",
    agentStateReason: "Test session",
    agentStateChangedAt: activity,
    customTitle: null,
    tags: [],
    starred: false,
    ignored: false,
    queuedMessageCount: 0,
    panes: [{
      id: `%${id.replace("$", "")}`,
      index: 0,
      window_index: 0,
      window_name: "shell",
      window_active: true,
      active: true,
      command: "bash",
      path,
      title: name,
      width: 120,
      height: 40,
      history_size: 0,
      history_limit: 2000,
      alternate_on: false,
      dead: false,
      activity,
    }],
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(listSessions).mockResolvedValue([]);
  window.localStorage.clear();
  document.title = "Muxdeck";
});

describe("NewSessionScreen", () => {
  it("waits for explicit confirmation and exposes the workspace tab panel", async () => {
    const onCreated = vi.fn();
    const onCancel = vi.fn();
    renderWithTheme(
      <NewSessionScreen
        onCreated={onCreated}
        onCancel={onCancel}
        sessionNavigation={<nav aria-label="Test workspace tabs">Tabs</nav>}
        desktopTabOrientation="vertical"
      />,
    );

    expect(createSession).not.toHaveBeenCalled();
    expect(document.title).toBe("New session - Muxdeck");
    expect(screen.getByRole("heading", { name: "Start a new session." })).toHaveFocus();
    expect(screen.getByRole("navigation", { name: "Test workspace tabs" })).toBeVisible();
    expect(screen.getByRole("main")).toHaveAttribute("data-desktop-tabs", "vertical");
    expect(screen.getByRole("tabpanel", { name: "Start a new session." })).toHaveAttribute(
      "id",
      NEW_SESSION_PANEL_ID,
    );
    expect(screen.getByRole("button", { name: "Light theme" })).toBeVisible();
    const nameInput = screen.getByRole("textbox", { name: /tmux session name/i });
    expect(nameInput).toHaveValue("");
    expect(nameInput).toHaveAttribute("maxlength", "256");
    expect(nameInput).toHaveAccessibleDescription(/leave blank for an assigned name/i);

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledOnce();
    expect(onCreated).not.toHaveBeenCalled();
  });

  it("blocks creation while a saved workspace is still opening", () => {
    const { container } = renderWithTheme(
      <NewSessionScreen
        onCreated={vi.fn()}
        onCancel={vi.fn()}
        workspaceLoading
      />,
    );
    const form = container.querySelector<HTMLFormElement>(".new-session-form")!;
    const input = screen.getByRole("textbox", { name: /tmux session name/i });

    expect(screen.getByRole("status")).toHaveTextContent(
      "Create becomes available when its tabs are ready.",
    );
    expect(screen.getByRole("button", { name: "Create session" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeEnabled();
    expect(input).toBeEnabled();
    expect(form).toHaveAttribute("aria-busy", "true");

    fireEvent.change(input, { target: { value: "draft-while-opening" } });
    fireEvent.submit(form);
    expect(createSession).not.toHaveBeenCalled();
    expect(input).toHaveValue("draft-while-opening");
  });

  it("creates exactly once while busy and reports the assigned session name", async () => {
    const request = deferredSession();
    const onCreated = vi.fn();
    vi.mocked(createSession).mockReturnValue(request.promise);
    const { container } = renderWithTheme(
      <NewSessionScreen onCreated={onCreated} onCancel={vi.fn()} />,
    );

    const form = container.querySelector<HTMLFormElement>(".new-session-form")!;
    fireEvent.submit(form);
    fireEvent.submit(form);

    expect(createSession).toHaveBeenCalledOnce();
    expect(createSession).toHaveBeenCalledWith(undefined, "dark", undefined);
    expect(form).toHaveAttribute("aria-busy", "true");
    expect(screen.getByRole("button", { name: "Creating..." })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    expect(screen.getByRole("textbox", { name: /tmux session name/i })).toBeDisabled();

    await act(async () => {
      request.resolve({ name: "muxdeck-42", id: "$42" });
      await request.promise;
    });

    expect(onCreated).toHaveBeenCalledOnce();
    expect(onCreated).toHaveBeenCalledWith("muxdeck-42", "$42");
    expect(form).toHaveAttribute("aria-busy", "false");
  });

  it("preserves an exact custom name while creating and trusts the returned name", async () => {
    const request = deferredSession();
    const onCreated = vi.fn();
    vi.mocked(createSession).mockReturnValue(request.promise);
    const { container } = renderWithTheme(
      <NewSessionScreen onCreated={onCreated} onCancel={vi.fn()} />,
    );
    const input = screen.getByRole("textbox", { name: /tmux session name/i });
    const form = container.querySelector<HTMLFormElement>(".new-session-form")!;

    fireEvent.change(input, { target: { value: "  work/session #1  " } });
    fireEvent.submit(form);
    fireEvent.submit(form);

    expect(createSession).toHaveBeenCalledOnce();
    expect(createSession).toHaveBeenCalledWith("  work/session #1  ", "dark", undefined);
    expect(input).toBeDisabled();

    await act(async () => {
      request.resolve({ name: "server-returned-name", id: "$43" });
      await request.promise;
    });

    expect(onCreated).toHaveBeenCalledWith("server-returned-name", "$43");
  });

  it("validates a custom name without blocking the assigned-name default", () => {
    renderWithTheme(<NewSessionScreen onCreated={vi.fn()} onCancel={vi.fn()} />);
    const input = screen.getByRole("textbox", { name: /tmux session name/i });
    const submit = screen.getByRole("button", { name: "Create session" });
    expect(submit).toBeEnabled();

    const invalidNames = [
      ["   ", "cannot be blank"],
      ["bad:name", "colon or period"],
      ["bad.name", "colon or period"],
      ["bad\\name", "backslash"],
      ["bad;", "end with a semicolon"],
    ];
    for (const [name, message] of invalidNames) {
      fireEvent.change(input, { target: { value: name } });
      expect(screen.getByRole("alert")).toHaveTextContent(message);
      expect(input).toHaveAttribute("aria-invalid", "true");
      expect(submit).toBeDisabled();
    }

    fireEvent.change(input, { target: { value: "  embedded;name #1  " } });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(input).not.toHaveAttribute("aria-invalid");
    expect(submit).toBeEnabled();

    fireEvent.change(input, { target: { value: "" } });
    expect(submit).toBeEnabled();
  });

  it("announces creation failures, retains the name, and permits a retry", async () => {
    vi.mocked(createSession)
      .mockRejectedValueOnce(new Error("duplicate session: existing"))
      .mockResolvedValueOnce({ name: "try-another-name", id: "$44" });
    const onCreated = vi.fn();
    renderWithTheme(<NewSessionScreen onCreated={onCreated} onCancel={vi.fn()} />);
    const input = screen.getByRole("textbox", { name: /tmux session name/i });

    fireEvent.change(input, { target: { value: "existing" } });
    fireEvent.click(screen.getByRole("button", { name: "Create session" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("duplicate session: existing");
    expect(input).toHaveValue("existing");
    expect(screen.getByRole("button", { name: "Create session" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeEnabled();

    fireEvent.change(input, { target: { value: "try-another-name" } });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Create session" }));
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith("try-another-name", "$44"));
    expect(createSession).toHaveBeenCalledTimes(2);
    expect(createSession).toHaveBeenNthCalledWith(1, "existing", "dark", undefined);
    expect(createSession).toHaveBeenNthCalledWith(2, "try-another-name", "dark", undefined);
  });

  it("uses the selected light appearance for Grok processes launched later", async () => {
    window.localStorage.setItem("muxdeck-theme", "light");
    vi.mocked(createSession).mockResolvedValue({ name: "light-session", id: "$46" });
    renderWithTheme(<NewSessionScreen onCreated={vi.fn()} onCancel={vi.fn()} />);

    expect(screen.getByText(
      /on tmux 3\.2\+, Grok Build launched here follows the current light appearance/i,
    )).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Create session" }));

    await waitFor(() => expect(createSession).toHaveBeenCalledWith(undefined, "light", undefined));
  });

  it("discovers and ranks known session workspaces for direct selection", async () => {
    const now = Math.floor(Date.now() / 1000);
    vi.mocked(listSessions).mockResolvedValue([
      sessionWorkspace("alpha", "$1", "/work/shared", now - 120),
      sessionWorkspace("beta", "$2", "/work/recent", now),
      sessionWorkspace("gamma", "$3", "/work/shared", now - 60),
    ]);
    renderWithTheme(<NewSessionScreen onCreated={vi.fn()} onCancel={vi.fn()} />);

    const shared = await screen.findByRole("button", {
      name: "Use workspace /work/shared",
    });
    const recent = screen.getByRole("button", { name: "Use workspace /work/recent" });
    const rankedPaths = screen.getAllByRole("button", { name: /Use workspace/ });
    expect(rankedPaths).toEqual([shared, recent]);
    expect(screen.getByText(/2 live sessions · seen/)).toBeVisible();
    expect(screen.getAllByText("LIVE NOW")).toHaveLength(2);

    fireEvent.click(recent);
    expect(screen.getByRole("textbox", { name: /starting directory/i }))
      .toHaveValue("/work/recent");
    fireEvent.click(screen.getByRole("button", { name: "Pin workspace /work/recent" }));
    expect(screen.getByRole("button", { name: "Unpin workspace /work/recent" }))
      .toHaveAttribute("aria-pressed", "true");

    fireEvent.click(screen.getByRole("button", {
      name: "Remove workspace /work/shared from suggestions",
    }));
    expect(screen.queryByRole("button", { name: "Use workspace /work/shared" }))
      .not.toBeInTheDocument();
  });

  it("pins, selects, hides, and restores working directories in this browser", () => {
    renderWithTheme(<NewSessionScreen onCreated={vi.fn()} onCancel={vi.fn()} />);
    const directoryInput = screen.getByRole("textbox", { name: /starting directory/i });
    const saveButton = screen.getByRole("button", { name: "Save path" });
    const createButton = screen.getByRole("button", { name: "Create session" });

    expect(directoryInput).toHaveValue("");
    expect(directoryInput).toHaveAccessibleDescription(/absolute path on the tmux server/i);
    expect(saveButton).toBeDisabled();
    expect(screen.getByText(/no known paths yet/i)).toBeVisible();

    fireEvent.change(directoryInput, { target: { value: "relative/project" } });
    expect(screen.getByRole("alert")).toHaveTextContent("absolute server path");
    expect(directoryInput).toHaveAttribute("aria-invalid", "true");
    expect(saveButton).toBeDisabled();
    expect(createButton).toBeDisabled();

    fireEvent.change(directoryInput, { target: { value: "/srv/projects/alpha one" } });
    fireEvent.click(saveButton);
    expect(JSON.parse(
      window.localStorage.getItem(NEW_SESSION_WORKSPACE_MEMORY_STORAGE_KEY) || "{}",
    )).toMatchObject({
      version: 1,
      entries: [{ path: "/srv/projects/alpha one", pinned: true }],
    });
    const alpha = screen.getByRole("button", {
      name: "Use workspace /srv/projects/alpha one",
    });
    expect(alpha).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText("PINNED")).toBeVisible();
    expect(saveButton).toBeDisabled();

    fireEvent.change(directoryInput, { target: { value: "/work/beta" } });
    fireEvent.click(saveButton);
    expect(screen.getByRole("button", { name: "Use workspace /work/beta" }))
      .toBeVisible();
    fireEvent.click(alpha);
    expect(directoryInput).toHaveValue("/srv/projects/alpha one");
    expect(alpha).toHaveAttribute("aria-pressed", "true");

    fireEvent.click(screen.getByRole("button", {
      name: "Remove workspace /srv/projects/alpha one from suggestions",
    }));
    expect(screen.queryByRole("button", {
      name: "Use workspace /srv/projects/alpha one",
    })).not.toBeInTheDocument();
    expect(directoryInput).toHaveValue("/srv/projects/alpha one");
    expect(saveButton).toBeEnabled();
    expect(screen.getByRole("button", { name: "Restore 1 hidden" })).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "Restore 1 hidden" }));
    expect(screen.getByRole("button", {
      name: "Use workspace /srv/projects/alpha one",
    })).toBeVisible();
    expect(screen.getByRole("button", {
      name: "Pin workspace /srv/projects/alpha one",
    })).toHaveAttribute("aria-pressed", "false");

    fireEvent.click(screen.getByRole("button", { name: "Use home" }));
    expect(directoryInput).toHaveValue("");
    expect(createButton).toBeEnabled();
  });

  it("migrates valid saved workspaces and records a launch from the selected directory", async () => {
    window.localStorage.setItem(
      NEW_SESSION_DIRECTORIES_STORAGE_KEY,
      JSON.stringify(["/work/alpha", "relative", "/work/alpha", 7, "/work/beta"]),
    );
    vi.mocked(createSession).mockResolvedValue({ name: "from-workspace", id: "$47" });
    const onCreated = vi.fn();
    renderWithTheme(<NewSessionScreen onCreated={onCreated} onCancel={vi.fn()} />);

    expect(screen.getAllByRole("button", { name: /Use workspace/ })).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", {
      name: "Use workspace /work/beta",
    }));
    expect(screen.getByRole("textbox", { name: /starting directory/i }))
      .toHaveValue("/work/beta");
    fireEvent.click(screen.getByRole("button", { name: "Create session" }));

    await waitFor(() => {
      expect(createSession).toHaveBeenCalledWith(undefined, "dark", "/work/beta");
    });
    expect(onCreated).toHaveBeenCalledWith("from-workspace", "$47");
    const stored = JSON.parse(
      window.localStorage.getItem(NEW_SESSION_WORKSPACE_MEMORY_STORAGE_KEY) || "{}",
    );
    expect(stored.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "/work/beta", pinned: true, launches: 1 }),
    ]));
  });

  it("delivers a successful result after SPA navigation unmounts the view", async () => {
    const request = deferredSession();
    const onCreated = vi.fn();
    vi.mocked(createSession).mockReturnValue(request.promise);
    const { unmount } = renderWithTheme(
      <NewSessionScreen onCreated={onCreated} onCancel={vi.fn()} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Create session" }));
    unmount();
    await act(async () => {
      request.resolve({ name: "muxdeck-after-navigation", id: "$45" });
      await request.promise;
    });

    expect(onCreated).toHaveBeenCalledOnce();
    expect(onCreated).toHaveBeenCalledWith("muxdeck-after-navigation", "$45");
  });
});
