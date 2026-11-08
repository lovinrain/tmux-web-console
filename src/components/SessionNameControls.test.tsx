import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SessionNameControls } from "./SessionNameControls";
import { session } from "./workspaceNavigation/testFixtures";

describe("SessionNameControls", () => {
  it("validates names, ignores composition Enter, and keeps a failed rename editable for retry", async () => {
    const target = session({ name: "agent" });
    const onRename = vi.fn().mockRejectedValueOnce(new Error("That name is already used.")).mockResolvedValue(undefined);
    render(<SessionNameControls name="agent" displayTitle="agent" session={target} onRename={onRename} />);
    fireEvent.doubleClick(screen.getByRole("button", { name: "Edit tmux session name" }));
    const input = screen.getByRole("textbox", { name: "Tmux session name" });
    fireEvent.change(input, { target: { value: "invalid.name" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.getByRole("alert")).toHaveTextContent("colon, period, or backslash");
    expect(onRename).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: "renamed-雪" } });
    fireEvent.keyDown(input, { key: "Enter", isComposing: true });
    expect(onRename).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: "Enter" });
    expect(await screen.findByRole("alert")).toHaveTextContent("That name is already used.");
    expect(input).toHaveValue("renamed-雪");
    expect(input).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Save tmux session name" }));
    await waitFor(() => expect(screen.queryByRole("textbox", { name: "Tmux session name" })).not.toBeInTheDocument());
    expect(onRename).toHaveBeenCalledTimes(2);
    expect(onRename).toHaveBeenLastCalledWith(target, "renamed-雪");
  });

  it("keeps the session identity captured at the start of an edit", async () => {
    const original = session({ name: "agent", id: "$11" });
    const replacement = session({ name: "agent", id: "$12" });
    const onRename = vi.fn().mockResolvedValue(undefined);
    const view = render(<SessionNameControls name="agent" displayTitle="agent" session={original} onRename={onRename} />);
    fireEvent.doubleClick(screen.getByRole("button", { name: "Edit tmux session name" }));
    view.rerender(<SessionNameControls name="agent" displayTitle="agent" session={replacement} onRename={onRename} />);
    fireEvent.change(screen.getByRole("textbox", { name: "Tmux session name" }), { target: { value: "new-agent" } });
    fireEvent.click(screen.getByRole("button", { name: "Save tmux session name" }));
    await waitFor(() => expect(onRename).toHaveBeenCalledExactlyOnceWith(original, "new-agent"));
  });

  it("offers the exact current name for manual copying when clipboard access fails, without saving a draft", async () => {
    const name = "  agent 雪  ";
    const copy = vi.fn().mockRejectedValue(new Error("Denied"));
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: copy } });
    const onRename = vi.fn();
    render(<SessionNameControls name={name} displayTitle="Display title" session={session({ name })} onRename={onRename} />);
    fireEvent.doubleClick(screen.getByRole("button", { name: "Edit tmux session name" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Tmux session name" }), { target: { value: "unsaved-name" } });
    const button = screen.getByRole("button", { name: "Copy tmux session name" });
    fireEvent.mouseDown(button);
    fireEvent.click(button);
    const manual = await screen.findByRole("textbox", { name: "Session name to copy" });
    expect(copy).toHaveBeenCalledExactlyOnceWith(name);
    expect(manual).toHaveValue(name);
    expect(manual).toHaveFocus();
    expect((manual as HTMLInputElement).selectionEnd).toBe(name.length);
    expect(onRename).not.toHaveBeenCalled();
  });
});
