import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getShortcutSettings,
  saveShortcutSettings,
  type ShortcutSettingsPayload,
} from "./api";
import {
  DEFAULT_SHORTCUT_BINDINGS,
  ShortcutSettingsProvider,
  canonicalShortcutCode,
  cloneShortcutBindings,
  directShortcutLabel,
  shortcutConflictMessages,
} from "./shortcutSettings";
import {
  WorkspaceCommandPalette,
  type WorkspaceCommand,
} from "./components/WorkspaceCommandPalette";

vi.mock("./api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./api")>();
  return {
    ...actual,
    getShortcutSettings: vi.fn(),
    saveShortcutSettings: vi.fn(),
  };
});

const getShortcutSettingsMock = vi.mocked(getShortcutSettings);
const saveShortcutSettingsMock = vi.mocked(saveShortcutSettings);

function snapshot(revision = 0): ShortcutSettingsPayload {
  return {
    revision,
    bindings: cloneShortcutBindings(DEFAULT_SHORTCUT_BINDINGS),
  };
}

beforeEach(() => {
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  });
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  getShortcutSettingsMock.mockResolvedValue(snapshot());
  saveShortcutSettingsMock.mockImplementation(async (bindings, revision) => ({
    revision: revision + 1,
    bindings,
  }));
});

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  document.body.style.overflow = "";
});

describe("shortcut helpers", () => {
  it("normalizes physical keys and detects conflicts independently by layer", () => {
    expect(canonicalShortcutCode("Numpad7")).toBe("Digit7");
    expect(canonicalShortcutCode("Escape")).toBeNull();
    expect(directShortcutLabel(DEFAULT_SHORTCUT_BINDINGS["command-palette"]))
      .toBe("Ctrl+Shift+H");

    const duplicate = cloneShortcutBindings(DEFAULT_SHORTCUT_BINDINGS);
    duplicate["session-end"].launcher = "KeyR";
    expect(shortcutConflictMessages(duplicate)).toEqual([
      "Shortcut window key R is used by Rename session and End session.",
    ]);
  });
});

describe("ShortcutSettingsProvider", () => {
  it("edits, persists, and immediately applies direct and shortcut-window keys", async () => {
    const runEnd = vi.fn();
    const commands: WorkspaceCommand[] = [{
      id: "session-end",
      shortcutId: "session-end",
      label: "Open End session confirmation",
      description: "Review before terminating the session.",
      category: "Session",
      danger: true,
      run: runEnd,
    }];
    render(
      <ShortcutSettingsProvider>
        <WorkspaceCommandPalette compactViewport={false} commands={commands} />
      </ShortcutSettingsProvider>,
    );

    await waitFor(() => expect(getShortcutSettingsMock).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole("button", { name: "Open shortcut window" }));
    const shortcutDialog = screen.getByRole("dialog", { name: "Keyboard shortcuts" });
    fireEvent.click(within(shortcutDialog).getByRole("button", { name: "Customize" }));

    const settings = screen.getByRole("dialog", { name: "Customize shortcuts" });
    const paletteDirect = within(settings).getByRole("button", {
      name: "Fuzzy command search direct key",
    });
    fireEvent.click(paletteDirect);
    fireEvent.keyDown(paletteDirect, { code: "KeyY", key: "y" });

    const launcherDirect = within(settings).getByRole("button", {
      name: "Shortcut window direct key",
    });
    fireEvent.click(launcherDirect);
    fireEvent.keyDown(launcherDirect, { code: "KeyX", key: "x" });

    const endLauncher = within(settings).getByRole("button", {
      name: "End session launcher key",
    });
    fireEvent.click(endLauncher);
    fireEvent.keyDown(endLauncher, { code: "KeyW", key: "w" });

    fireEvent.click(within(settings).getByRole("button", { name: "Save keymap" }));
    await waitFor(() => expect(saveShortcutSettingsMock).toHaveBeenCalledOnce());
    const [savedBindings, revision] = saveShortcutSettingsMock.mock.calls[0];
    expect(revision).toBe(0);
    expect(savedBindings["command-palette"].direct).toBe("KeyY");
    expect(savedBindings["shortcut-launcher"].direct).toBe("KeyX");
    expect(savedBindings["session-end"].launcher).toBe("KeyW");
    await waitFor(() => expect(within(settings).getByText("Saved for every browser."))
      .toBeVisible());
    fireEvent.click(within(settings).getByRole("button", {
      name: "Close shortcut settings",
    }));

    const commandTrigger = screen.getByRole("button", { name: "Open command palette" });
    const shortcutTrigger = screen.getByRole("button", { name: "Open shortcut window" });
    expect(commandTrigger).toHaveAttribute("aria-keyshortcuts", "Control+Shift+Y");
    expect(shortcutTrigger).toHaveAttribute("aria-keyshortcuts", "Control+Shift+X");

    fireEvent.keyDown(window, {
      code: "KeyH",
      key: "H",
      ctrlKey: true,
      shiftKey: true,
    });
    expect(screen.queryByRole("dialog", { name: "Run a command" })).not.toBeInTheDocument();
    fireEvent.keyDown(window, {
      code: "KeyY",
      key: "Y",
      ctrlKey: true,
      shiftKey: true,
    });
    expect(screen.getByRole("dialog", { name: "Run a command" })).toBeVisible();
    fireEvent.keyDown(window, { key: "Escape" });

    fireEvent.keyDown(window, {
      code: "KeyX",
      key: "X",
      ctrlKey: true,
      shiftKey: true,
    });
    const remappedShortcuts = screen.getByRole("dialog", { name: "Keyboard shortcuts" });
    expect(within(remappedShortcuts).getByRole("button", {
      name: /Open End session confirmation/,
    })).toHaveTextContent("W");
    fireEvent.keyDown(window, { code: "KeyW", key: "w" });
    expect(runEnd).toHaveBeenCalledOnce();
  });
});
