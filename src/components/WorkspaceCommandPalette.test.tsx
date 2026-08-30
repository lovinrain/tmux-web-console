import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  WorkspaceCommandPalette,
  rankWorkspaceCommands,
  type WorkspaceCommand,
} from "./WorkspaceCommandPalette";

function command(
  id: string,
  label: string,
  overrides: Partial<WorkspaceCommand> = {},
): WorkspaceCommand {
  return {
    id,
    label,
    description: `${label} description`,
    category: "Workspace",
    run: vi.fn(),
    ...overrides,
  };
}

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

describe("rankWorkspaceCommands", () => {
  const commands = [
    command("theme", "Toggle light or dark theme", { keywords: ["appearance"] }),
    command("rename", "Rename tmux session", { shortcut: "Ctrl+Shift+R" }),
    command("open", "Switch to Emerald release", {
      category: "Open tabs",
      description: "alpha-native-helper - workspace tab 2.",
      keywords: ["claude", "working"],
    }),
  ];

  it("keeps source order without a query and ranks exact labels first", () => {
    expect(rankWorkspaceCommands(commands, "").map(({ command: result }) => result.id))
      .toEqual(["theme", "rename", "open"]);
    expect(rankWorkspaceCommands(commands, "rename tmux session")[0].command.id)
      .toBe("rename");
  });

  it("matches fuzzy initials and tokens spread across searchable fields", () => {
    expect(rankWorkspaceCommands(commands, "rn ssn")[0].command.id).toBe("rename");
    expect(rankWorkspaceCommands(commands, "alpha wrk")[0].command.id).toBe("open");
    expect(rankWorkspaceCommands(commands, "appr")[0].command.id).toBe("theme");
  });

  it("returns no commands when any query token has no fuzzy match", () => {
    expect(rankWorkspaceCommands(commands, "rename impossible-token")).toEqual([]);
  });
});

describe("WorkspaceCommandPalette", () => {
  it("opens fuzzy search from Ctrl+Shift+H even when keydown was pre-consumed", () => {
    const consumeShortcut = (event: KeyboardEvent) => {
      if (event.code === "KeyH") event.preventDefault();
    };
    window.addEventListener("keydown", consumeShortcut, true);
    render(
      <WorkspaceCommandPalette
        compactViewport={false}
        commands={[command("theme", "Toggle theme")]}
      />,
    );

    fireEvent.keyDown(window, {
      code: "KeyH",
      key: "H",
      ctrlKey: true,
      shiftKey: true,
    });
    window.removeEventListener("keydown", consumeShortcut, true);
    expect(screen.getByRole("dialog", { name: "Run a command" })).toBeVisible();
    fireEvent.keyUp(window, {
      code: "KeyH",
      key: "H",
      ctrlKey: true,
      shiftKey: true,
    });
  });

  it("does not run a disabled fuzzy match", () => {
    const run = vi.fn();
    render(
      <WorkspaceCommandPalette
        compactViewport={false}
        commands={[command("disabled", "Rename tmux session", {
          disabled: true,
          disabledReason: "Open a live session first.",
          run,
        })]}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Open command palette" }));
    const palette = screen.getByRole("dialog", { name: "Run a command" });
    const search = within(palette).getByRole("combobox", { name: "Search commands" });
    fireEvent.change(search, { target: { value: "rn ssn" } });
    expect(within(palette).getByRole("option", { name: /Rename tmux session/ }))
      .toBeDisabled();
    fireEvent.keyDown(search, { key: "Enter" });
    expect(run).not.toHaveBeenCalled();
    expect(palette).toBeVisible();
  });

  it("stays unavailable on compact viewports", () => {
    render(
      <WorkspaceCommandPalette
        compactViewport
        commands={[command("theme", "Toggle theme")]}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Open command palette" }));
    fireEvent.keyDown(window, {
      code: "KeyH",
      key: "H",
      ctrlKey: true,
      shiftKey: true,
    });
    fireEvent.keyDown(window, {
      code: "KeyZ",
      key: "Z",
      ctrlKey: true,
      shiftKey: true,
    });
    expect(screen.queryByRole("dialog", { name: "Run a command" })).not.toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "Keyboard shortcuts" }))
      .not.toBeInTheDocument();
  });
});
