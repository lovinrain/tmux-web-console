import { fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sessions } from "./testFixtures";
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

describe("WorkspaceTabSearchDialog", () => {
  it("finds tabs by group name and exposes their group name and color", () => {
    render(
      <WorkspaceTabSearchDialog
        activeSession="alpha"
        openSessions={["alpha", "beta", "zulu"]}
        groups={[{
          id: "release-lane",
          name: "Release lane",
          color: "orange",
          collapsed: false,
          tabs: ["beta", "zulu"],
        }]}
        sessions={sessions}
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    const dialog = screen.getByRole("dialog", { name: "Jump to tab" });
    fireEvent.change(within(dialog).getByRole("combobox"), {
      target: { value: "release" },
    });

    const results = within(dialog).getAllByRole("option");
    expect(results).toHaveLength(2);
    expect(results[0]).toHaveTextContent("beta");
    expect(results[1]).toHaveTextContent("Zulu shell");
    for (const result of results) {
      const metadata = within(result).getByLabelText(
        "Tab group Release lane, color orange",
      );
      expect(metadata).toHaveTextContent("Release lane");
      expect(metadata).toHaveAttribute("data-tab-group-color", "orange");
    }
  });

  it("floats the jumper without a backdrop or focus trap, keeps it open after a jump, and restores modal behavior", () => {
    const onClose = vi.fn();
    const onSelect = vi.fn();
    function Picker() {
      const [floating, setFloating] = useState(false);
      const [active, setActive] = useState("alpha");
      return <>
        <button type="button">Outside terminal control</button>
        <WorkspaceTabSearchDialog activeSession={active} openSessions={["alpha", "beta"]}
          sessions={sessions} workspaceKey="test-floating-picker"
          floating={floating} onFloatingChange={setFloating} onClose={onClose}
          onSelect={(name) => { onSelect(name); setActive(name); }} />
      </>;
    }
    render(<Picker />);
    let dialog = screen.getByRole("dialog", { name: "Jump to tab" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(document.body.style.overflow).toBe("hidden");
    fireEvent.click(within(dialog).getByRole("button", { name: "Float session jumper" }));
    dialog = screen.getByRole("dialog", { name: "Jump to tab" });
    expect(dialog).toHaveAttribute("aria-modal", "false");
    expect(dialog).toHaveAttribute("data-floating", "true");
    expect(document.querySelector(".workspace-tab-search-backdrop")).not.toBeInTheDocument();
    expect(document.body.style.overflow).toBe("");
    const outside = screen.getByRole("button", { name: "Outside terminal control" });
    outside.focus();
    expect(fireEvent.keyDown(outside, { key: "Tab" })).toBe(true);
    expect(fireEvent.keyDown(outside, { key: "Escape" })).toBe(true);
    expect(onClose).not.toHaveBeenCalled();
    const search = within(dialog).getByRole("combobox");
    fireEvent.change(search, { target: { value: "beta" } });
    fireEvent.keyDown(search, { key: "Enter" });
    expect(onSelect).toHaveBeenCalledWith("beta");
    expect(onClose).not.toHaveBeenCalled();
    expect(dialog).toBeVisible();
    expect(search).toHaveValue("");
    expect(within(dialog).getByRole("option", { name: /beta/ })).toHaveTextContent("Current");
    fireEvent.click(within(dialog).getByRole("button", { name: "Use modal session jumper" }));
    dialog = screen.getByRole("dialog", { name: "Jump to tab" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(document.body.style.overflow).toBe("hidden");
    fireEvent.keyDown(within(dialog).getByRole("combobox"), { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it.each([
    { floating: false, interaction: "keyboard" },
    { floating: true, interaction: "keyboard" },
    { floating: true, interaction: "pointer" },
  ])("keeps the highlighted session through live metadata updates: %j", ({ floating, interaction }) => {
    const onSelect = vi.fn();
    const onClose = vi.fn();
    const props = {
      activeSession: "alpha", openSessions: ["alpha", "beta", "zulu"], sessions, groups: [],
      floating, onSelect, onClose,
    };
    const view = render(<WorkspaceTabSearchDialog {...props} />);
    const dialog = screen.getByRole("dialog", { name: "Jump to tab" });
    const search = within(dialog).getByRole("combobox");
    const beta = within(dialog).getByRole("option", { name: /beta/ });
    if (interaction === "keyboard") fireEvent.keyDown(search, { key: "ArrowDown" });
    else fireEvent.mouseEnter(beta);
    expect(beta).toHaveAttribute("aria-selected", "true");

    view.rerender(<WorkspaceTabSearchDialog {...props} sessions={sessions.map((item) => (
      item.name === "beta"
        ? { ...item, customTitle: "Beta updated", agentState: "waiting_human" as const, activity: item.activity + 1 }
        : { ...item }
    ))} />);
    const updated = within(dialog).getByRole("option", { name: /Beta updated/ });
    expect(updated).toHaveAttribute("aria-selected", "true");
    expect(search).toHaveAttribute("aria-activedescendant", updated.id);
    expect(onSelect).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(search, { key: "Enter" });
    expect(onSelect).toHaveBeenCalledExactlyOnceWith("beta");
  });

  it("preserves the highlighted tab on reorder, recovers on removal, and follows explicit view and search changes", () => {
    const props = {
      activeSession: "alpha", openSessions: ["alpha", "beta", "zulu"], sessions, groups: [],
      floating: true, onSelect: vi.fn(), onClose: vi.fn(),
    };
    const view = render(<WorkspaceTabSearchDialog {...props} />);
    const dialog = screen.getByRole("dialog", { name: "Jump to tab" });
    const search = within(dialog).getByRole("combobox");
    fireEvent.keyDown(search, { key: "ArrowDown" });
    view.rerender(<WorkspaceTabSearchDialog {...props} openSessions={["zulu", "alpha", "beta"]} />);
    expect(within(dialog).getByRole("option", { name: /beta/ })).toHaveAttribute("aria-selected", "true");
    view.rerender(<WorkspaceTabSearchDialog {...props} openSessions={["zulu", "alpha"]} />);
    expect(within(dialog).getByRole("option", { name: /Alpha control/ })).toHaveAttribute("aria-selected", "true");
    view.rerender(<WorkspaceTabSearchDialog {...props} activeSession="zulu" openSessions={["zulu", "alpha"]} />);
    expect(within(dialog).getByRole("option", { name: /Zulu shell/ })).toHaveAttribute("aria-selected", "true");
    fireEvent.change(search, { target: { value: "alpha" } });
    expect(within(dialog).getByRole("option", { name: /Alpha control/ })).toHaveAttribute("aria-selected", "true");
    fireEvent.change(search, { target: { value: "" } });
    expect(within(dialog).getByRole("option", { name: /Zulu shell/ })).toHaveAttribute("aria-selected", "true");
    expect(props.onSelect).not.toHaveBeenCalled();
  });

  it("moves and resizes the floating jumper with the keyboard and restores its workspace geometry after reopening", () => {
    const props = {
      activeSession: "alpha", openSessions: ["alpha", "beta"], sessions,
      workspaceKey: "test-jumper-geometry", floating: true,
      onSelect: vi.fn(), onClose: vi.fn(),
    };
    const view = render(<WorkspaceTabSearchDialog {...props} />);
    const dialog = screen.getByRole("dialog", { name: "Jump to tab" });
    const left = Number.parseFloat(dialog.style.left);
    const width = Number.parseFloat(dialog.style.width);
    const move = within(dialog).getByLabelText("Move session jumper window");
    fireEvent.keyDown(move, { key: "ArrowLeft" });
    expect(Number.parseFloat(dialog.style.left)).toBe(left - 16);
    const resize = within(dialog).getByRole("button", { name: "Resize session jumper window" });
    fireEvent.keyDown(resize, { key: "ArrowRight", shiftKey: true });
    expect(Number.parseFloat(dialog.style.width)).toBe(width + 64);
    const geometry = { left: dialog.style.left, top: dialog.style.top, width: dialog.style.width, height: dialog.style.height };
    view.unmount();
    render(<WorkspaceTabSearchDialog {...props} />);
    const reopened = screen.getByRole("dialog", { name: "Jump to tab" });
    expect({ left: reopened.style.left, top: reopened.style.top, width: reopened.style.width, height: reopened.style.height }).toEqual(geometry);
    fireEvent.keyDown(within(reopened).getByLabelText("Move session jumper window"), { key: "Home" });
    expect(reopened.style.width).toBe(`${width}px`);
  });

  it("returns focus to the active terminal after the original terminal is replaced, without stealing outside focus", () => {
    const original = document.createElement("textarea");
    document.body.append(original);
    original.focus();
    const view = render(<WorkspaceTabSearchDialog activeSession="alpha"
      openSessions={["alpha", "beta"]} sessions={sessions} floating
      onSelect={vi.fn()} onClose={vi.fn()} />);
    original.remove();
    const console = document.createElement("div");
    console.id = "muxdeck-active-console";
    console.innerHTML = '<textarea class="xterm-helper-textarea"></textarea><button>Outside</button>';
    document.body.append(console);
    const terminal = console.querySelector("textarea")!;
    within(screen.getByRole("dialog", { name: "Jump to tab" })).getByRole("combobox").focus();
    view.unmount();
    expect(terminal).toHaveFocus();

    const reopened = render(<WorkspaceTabSearchDialog activeSession="beta"
      openSessions={["alpha", "beta"]} sessions={sessions} floating
      onSelect={vi.fn()} onClose={vi.fn()} />);
    const outside = console.querySelector("button")!;
    outside.focus();
    reopened.unmount();
    expect(outside).toHaveFocus();
    console.remove();
  });

  it("shows nesting and parent context in tab search even when the parent is filtered out", () => {
    const onSelect = vi.fn();
    render(
      <WorkspaceTabSearchDialog
        activeSession="alpha"
        openSessions={["alpha", "beta", "zulu"]}
        sessionParents={{ beta: "alpha", zulu: "beta" }}
        sessions={sessions}
        onSelect={onSelect}
        onClose={vi.fn()}
      />,
    );

    const dialog = screen.getByRole("dialog", { name: "Jump to tab" });
    const [root, child, grandchild] = within(dialog).getAllByRole("option");
    expect(root).not.toHaveAttribute("data-session-parent");
    expect(child).toHaveAttribute("data-session-parent", "alpha");
    expect(child).toHaveAttribute("data-session-depth", "1");
    expect(child).toHaveTextContent("Child of Alpha control");
    expect(grandchild).toHaveAttribute("data-session-depth", "2");
    expect(grandchild).toHaveAccessibleDescription("Child of beta. Nesting level 2.");

    fireEvent.change(within(dialog).getByRole("combobox"), {
      target: { value: "Zulu" },
    });
    const result = within(dialog).getByRole("option");
    expect(result).toHaveTextContent("Child of beta");
    expect(result.style.getPropertyValue("--workspace-session-depth")).toBe("2");
    fireEvent.click(result);
    expect(onSelect).toHaveBeenCalledWith("zulu");
  });
});
