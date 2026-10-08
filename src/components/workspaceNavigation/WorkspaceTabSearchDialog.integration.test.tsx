import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionWorkspaceNavigation } from "../SessionWorkspaceNavigation";
import { navigationProps, session, sessions } from "./testFixtures";
import { WorkspaceTabSearchDialog } from "./WorkspaceTabSearchDialog";

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
describe("Workspace navigation and search integration", () => {
  it("shows command-running status in tabs, Overview, and tab search", () => {
    const runningSession = session({ name: "command-task", agentState: "running_command" });
    const visibleSessions = [sessions[0], runningSession];
    const view = render(
      <SessionWorkspaceNavigation
        {...navigationProps({
          openSessions: ["alpha", "command-task"],
          recentSessions: ["command-task"],
          sessions: visibleSessions,
          recentsOpen: true,
        })}
      />,
    );

    const tab = screen.getByRole("tab", { name: "command-task, Command running" });
    expect(tab.querySelector(".workspace-state-dot")).toHaveClass("running_command");
    const openGroup = screen.getByRole("region", { name: "Open tabs" });
    const status = within(openGroup).getByText("Command running");
    expect(status).toHaveClass("workspace-session-status", "running_command");
    view.unmount();

    render(
      <WorkspaceTabSearchDialog
        activeSession="alpha"
        openSessions={["alpha", "command-task"]}
        sessions={visibleSessions}
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    const dialog = screen.getByRole("dialog", { name: "Jump to tab" });
    fireEvent.change(within(dialog).getByRole("combobox"), { target: { value: "command-task" } });
    const result = within(dialog).getByRole("option");
    expect(result).toHaveTextContent("Command running");
    expect(result.querySelector(".workspace-state-dot")).toHaveClass("running_command");
    expect(result.querySelector(".workspace-tab-search-result-state")).toHaveClass("running_command");
  });
});
